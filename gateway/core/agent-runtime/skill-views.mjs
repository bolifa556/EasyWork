import crypto from "node:crypto";
import { invariant } from "../errors.mjs";
import { parseNativeSkill } from "../skills/native-package.mjs";

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const missing = (error) => ["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code);
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

function verifyDescriptor(descriptor, root, digest) {
  const { sha256, ...content } = descriptor;
  invariant(sha256 === digest && hash(canonical(content)) === digest && descriptor.root === root
    && Array.isArray(descriptor.files) && Array.isArray(descriptor.skillPins)
    && descriptor.files.length <= 10000 && descriptor.files.reduce((size, file) => size + file.size, 0) <= 64 * 1024 * 1024,
  "AGENT_SKILL_SNAPSHOT_CHANGED", "分支技能快照已变化", { status: 409 });
}

export async function readSkillView(executor, paths) {
  try { return JSON.parse((await executor.readFile(`${paths.runtimeState}/skill-view.json`)).toString("utf8")); }
  catch (error) { if (missing(error)) return { schemaVersion: 1, skills: [] }; throw error; }
}

// The wrapper is a native Skill command, never ordinary supplementary prompt
// text. Each selected entry is read from this binding's mutable copy so edits
// made in one native conversation remain effective only in that conversation.
export async function selectedSkillCommand(executor, paths, skills) {
  if (!skills.length) return null;
  const sections = [];
  for (const skill of skills) {
    const document = await executor.readFile(`${skill.remotePath}/SKILL.md`);
    const parsed = parseNativeSkill(document);
    sections.push(`## ${parsed.metadata.name || skill.skillId}\n\nBase directory for this skill: ${skill.remotePath}\n\n${parsed.body.trim()}`);
  }
  const content = `---\nname: easywork-selected\ndescription: Apply the skills explicitly selected for this turn.\ndisable-model-invocation: true\n---\n\n${sections.join("\n\n")}\n\n## User request\n\n$ARGUMENTS\n`;
  await executor.writeAtomic(`${paths.skillsRoot}/easywork-selected/SKILL.md`, content, { mode: 0o600 });
  return { name: "easywork-selected", sha256: hash(content), path: `${paths.skillsRoot}/easywork-selected/SKILL.md` };
}

const SNAPSHOT_SCRIPT = String.raw`
import os,sys,json,hashlib,shutil,uuid,stat
p=json.loads(sys.argv[1]); root=os.path.realpath(p['runtimeRoot']); target=p['target']
def inside(path,base): return os.path.commonpath([os.path.realpath(path),base])==base
assert inside(target,root) and target!=root
manifestfile=os.path.join(target,'snapshot.json')
if os.path.isfile(manifestfile):
 print(open(manifestfile,encoding='utf-8').read()); sys.exit(0)
stage=target+'.stage-'+str(uuid.uuid4()); os.makedirs(stage,mode=0o700)
files=[]; total=0
try:
 for name in sorted(os.listdir(p['skillsRoot'])):
  if name=='easywork-selected' or name.startswith('.'): continue
  source=os.path.join(p['skillsRoot'],name)
  assert inside(source,root) and os.path.isdir(source), 'skill directory escapes binding'
  for current,dirs,names in os.walk(source,followlinks=False):
   for directory in dirs:
    assert not os.path.islink(os.path.join(current,directory)), 'nested symlink in skill'
   for filename in sorted(names):
    sourcefile=os.path.join(current,filename); attrs=os.lstat(sourcefile)
    assert stat.S_ISREG(attrs.st_mode), 'non-regular skill file'
    total+=attrs.st_size
    assert total<=67108864 and len(files)<10000, 'skill snapshot too large'
    rel=name+'/'+os.path.relpath(sourcefile,source).replace(os.sep,'/'); destination=os.path.join(stage,'files',rel)
    os.makedirs(os.path.dirname(destination),exist_ok=True); shutil.copyfile(sourcefile,destination)
    data=open(destination,'rb').read(); files.append({'path':rel,'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mode':stat.S_IMODE(attrs.st_mode)})
 pins=p.get('pins',[]); names={f['path'].split('/')[0] for f in files}; pins=[x for x in pins if x['skillId'] in names]
 descriptor={'schemaVersion':1,'root':target,'skillPins':pins,'files':files}
 digest=hashlib.sha256(json.dumps(descriptor,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
 descriptor['sha256']=digest
 open(os.path.join(stage,'snapshot.json'),'w',encoding='utf-8').write(json.dumps(descriptor))
 os.makedirs(os.path.dirname(target),exist_ok=True); os.rename(stage,target)
 print(json.dumps(descriptor))
except:
 shutil.rmtree(stage); raise
`;

export async function captureSkillSnapshot(executor, paths, taskId, pins) {
  invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(taskId)), "AGENT_SKILL_CHECKPOINT_INVALID", "技能快照边界无效", { status: 400 });
  const target = `${paths.runtimeRoot}/skill-snapshots/${taskId}`;
  const result = await executor.exec(`python3 -c ${quote(SNAPSHOT_SCRIPT)} ${quote(JSON.stringify({ runtimeRoot: paths.runtimeRoot, skillsRoot: paths.skillsRoot, target, pins }))}`, { maxOutputBytes: 4 * 1024 * 1024 });
  invariant(result.code === 0, "AGENT_SKILL_SNAPSHOT_FAILED", "无法保存当前回合的技能文件快照", { status: 502 });
  const snapshot = JSON.parse(result.stdout);
  verifyDescriptor(snapshot, target, snapshot.sha256);
  return { schemaVersion: 1, root: target, sha256: snapshot.sha256, skillPins: snapshot.skillPins };
}

export async function restoreSkillSnapshot(executor, paths, snapshot) {
  if (!snapshot) return;
  invariant(String(snapshot.root || "").startsWith(`${paths.easyworkRoot}/runtime/agents/`) && /\/skill-snapshots\/[A-Za-z0-9._:-]+$/.test(snapshot.root), "AGENT_SKILL_SNAPSHOT_INVALID", "技能快照路径无效", { status: 409 });
  const existing = await readSkillView(executor, paths);
  if (existing.inheritedSnapshot === snapshot.sha256) return;
  invariant(!existing.skills.length, "AGENT_SKILL_SNAPSHOT_CONFLICT", "当前分支已存在独立技能文件", { status: 409 });
  const descriptor = JSON.parse((await executor.readFile(`${snapshot.root}/snapshot.json`)).toString("utf8"));
  verifyDescriptor(descriptor, snapshot.root, snapshot.sha256);
  const ownedRoot = `${paths.runtimeRoot}/skill-generations/${crypto.randomUUID()}`;
  const skills = [];
  const groups = Map.groupBy(descriptor.files, (file) => String(file.path).split("/")[0]);
  for (const [skillId, files] of groups) {
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillId), "AGENT_SKILL_SNAPSHOT_INVALID", "快照技能名称无效", { status: 409 });
    for (const file of files) {
      invariant(file.path.startsWith(`${skillId}/`) && !file.path.split("/").some((piece) => piece === ".." || piece === "." || !piece) && !file.path.includes("\\"), "AGENT_SKILL_SNAPSHOT_INVALID", "快照文件路径无效", { status: 409 });
      const bytes = await executor.readFile(`${snapshot.root}/files/${file.path}`);
      invariant(bytes.length === file.size && hash(bytes) === file.sha256, "AGENT_SKILL_SNAPSHOT_CHANGED", "分支技能快照内容已变化", { status: 409 });
      await executor.writeAtomic(`${ownedRoot}/${file.path}`, bytes, { mode: 0o600 | (Number(file.mode || 0) & 0o111) });
    }
    const document = await executor.readFile(`${ownedRoot}/${skillId}/SKILL.md`);
    const pin = descriptor.skillPins.find((item) => item.skillId === skillId);
    const record = { ...(pin || { skillId, version: "branch-local", sha256: hash(document) }), nativeName: parseNativeSkill(document).metadata.name, viewHash: hash(JSON.stringify(files)), ownedRoot: `${ownedRoot}/${skillId}`, remotePath: `${paths.skillsRoot}/${skillId}` };
    const pendingLink = `${record.remotePath}.snapshot-${crypto.randomUUID()}`;
    const result = await executor.exec(`ln -s -- ${quote(record.ownedRoot)} ${quote(pendingLink)} && mv -Tf -- ${quote(pendingLink)} ${quote(record.remotePath)}`, { maxOutputBytes: 2048 });
    invariant(result.code === 0, "AGENT_SKILL_VIEW_FAILED", "无法建立分支独立技能目录", { status: 502 });
    skills.push(record);
  }
  await executor.writeAtomic(`${paths.runtimeState}/skill-view.json`, `${JSON.stringify({ schemaVersion: 1, inheritedSnapshot: snapshot.sha256, skills })}\n`, { mode: 0o600 });
}
