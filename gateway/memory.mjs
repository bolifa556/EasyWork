import crypto from "node:crypto";

const MEMORY_SCHEMA_VERSION = 2;
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_COMPRESSION_THRESHOLD = 0.95;
const DEFAULT_RELEVANCE_THRESHOLD = 0.035;

function nowIso() {
  return new Date().toISOString();
}

function stableId(prefix, value) {
  return `${prefix}_${crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 20)}`;
}

function uniqueStrings(...groups) {
  return [...new Set(groups.flat(Infinity).filter(Boolean).map(String))];
}

function contentFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function textTokens(value) {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase();
  const latin = text.match(/[a-z0-9_.:/-]{2,}/g) || [];
  const hanRuns = text.match(/[\p{Script=Han}]+/gu) || [];
  const han = [];
  for (const run of hanRuns) {
    if (run.length <= 2) han.push(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      han.push(run.slice(index, index + 2));
    }
  }
  return new Set([...latin, ...han]);
}

function relevanceScore(content, queryTokens) {
  if (!queryTokens.size) return 1;
  const candidate = textTokens(content);
  if (!candidate.size) return 0;
  let overlap = 0;
  for (const token of queryTokens) if (candidate.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.sqrt(candidate.size * queryTokens.size));
}

function normalizedStatus(value) {
  return ["active", "disabled", "deleted"].includes(String(value))
    ? String(value)
    : "active";
}

function normalizedSensitivity(value) {
  return ["normal", "personal", "restricted", "secret"].includes(String(value))
    ? String(value)
    : "normal";
}

function looksLikeCredential(value) {
  const text = String(value || "");
  return (
    /-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/i.test(text) ||
    /\bsk-[a-z0-9_-]{16,}\b/i.test(text) ||
    /\b(?:api[_ -]?key|password|passwd|密码)\s*[:=]\s*\S{8,}/i.test(text)
  );
}

function normalizeVersion(raw, fallback, sequence) {
  const source = raw && typeof raw === "object" ? raw : {};
  const content = String(source.content ?? fallback.content ?? "").trim().slice(0, 2_000);
  const createdAt = String(
    source.createdAt || source.updatedAt || fallback.updatedAt || fallback.createdAt || nowIso(),
  );
  const sourceConversationIds = uniqueStrings(
    source.sourceConversationIds || [],
    source.sourceConversationId,
  );
  const sourceTaskIds = uniqueStrings(
    source.sourceTaskIds || [],
    source.sourceTaskId,
  );
  const sourceMessageIds = uniqueStrings(
    source.sourceMessageIds || [],
  );
  const sourceCheckpointIds = uniqueStrings(
    source.sourceCheckpointIds || [],
    source.sourceCheckpointId,
  );
  const versionSequence = Math.max(1, Number(source.sequence || sequence || 1));
  return {
    versionId: String(
      source.versionId ||
        stableId(
          "memory_version",
          `${fallback.id}:${versionSequence}:${createdAt}:${contentFingerprint(content)}`,
        ),
    ),
    revision: Math.max(1, Number(source.revision || fallback.revision || 1)),
    sequence: versionSequence,
    status: normalizedStatus(source.status ?? fallback.status),
    content,
    summary: String(source.summary ?? fallback.summary ?? content).trim().slice(0, 800),
    kind: String(source.kind || fallback.kind || "fact"),
    portability: String(source.portability || fallback.portability || "universal"),
    authority: String(source.authority || fallback.authority || "unknown"),
    confidence: Math.max(
      0,
      Math.min(1, Number(source.confidence ?? fallback.confidence ?? 0.5)),
    ),
    sensitivity: normalizedSensitivity(source.sensitivity ?? fallback.sensitivity),
    validUntil: String(source.validUntil || fallback.validUntil || "") || undefined,
    contentFingerprint: String(
      source.contentFingerprint || contentFingerprint(content),
    ),
    source: String(source.source || fallback.source || "unknown"),
    sourceMessageIds,
    sourceConversationId:
      String(source.sourceConversationId || sourceConversationIds.at(-1) || "") ||
      undefined,
    sourceConversationIds,
    sourceTaskId:
      String(source.sourceTaskId || sourceTaskIds.at(-1) || "") || undefined,
    sourceTaskIds,
    sourceWorkspaceId:
      String(source.sourceWorkspaceId || "") ||
      undefined,
    sourceCheckpointId:
      String(source.sourceCheckpointId || sourceCheckpointIds.at(-1) || "") ||
      undefined,
    sourceCheckpointIds,
    sourceAgentId:
      String(source.sourceAgentId || "") || undefined,
    sourceAgentSessionId:
      String(source.sourceAgentSessionId || "") || undefined,
    evidenceRefs: uniqueStrings(source.evidenceRefs || []),
    createdAt,
    invalidatedAt: String(source.invalidatedAt || "") || undefined,
    invalidatedSequence:
      Number.isFinite(Number(source.invalidatedSequence)) &&
      Number(source.invalidatedSequence) > 0
        ? Number(source.invalidatedSequence)
        : undefined,
    invalidatedReason: String(source.invalidatedReason || "") || undefined,
    invalidatedBy: String(source.invalidatedBy || "") || undefined,
  };
}

function versionAllowedBySnapshot(
  version,
  asOfSequence,
  lineageConversationId,
  snapshotVersionIds,
) {
  if (!Number.isFinite(asOfSequence)) return true;
  if (Number(version.sequence || 0) <= asOfSequence) return true;
  if (snapshotVersionIds?.has(String(version.versionId || ""))) return true;
  return Boolean(
    lineageConversationId &&
      String(version.sourceConversationId || "") === String(lineageConversationId),
  );
}

function projectRecord(
  record,
  { asOfSequence, lineageConversationId, snapshotVersionIds = [] } = {},
) {
  const allowedVersionIds =
    snapshotVersionIds instanceof Set
      ? snapshotVersionIds
      : new Set((snapshotVersionIds || []).map(String));
  const eligible = (record.versions || [])
    .filter((version) => {
      if (!version.invalidatedAt) return true;
      if (allowedVersionIds.has(String(version.versionId || ""))) return true;
      return Boolean(
        Number.isFinite(asOfSequence) &&
          Number(version.invalidatedSequence || 0) > Number(asOfSequence),
      );
    })
    .filter((version) =>
      versionAllowedBySnapshot(
        version,
        asOfSequence,
        lineageConversationId,
        allowedVersionIds,
      ),
    )
    .sort(
      (left, right) =>
        Number(left.sequence || 0) - Number(right.sequence || 0) ||
        String(left.createdAt || "").localeCompare(String(right.createdAt || "")),
    );
  const latest = eligible.at(-1);
  if (!latest) {
    return {
      ...record,
      status: "deleted",
      content: String(record.content || ""),
      summary: String(record.summary || ""),
      sourceConversationIds: [],
      sourceTaskIds: [],
      sourceMessageIds: [],
      sourceCheckpointIds: [],
    };
  }
  const provenance = eligible.filter((version) => version.status === "active");
  return {
    ...record,
    ...latest,
    id: record.id,
    revision: Math.max(Number(record.revision || 0), Number(latest.revision || 0)),
    versions: record.versions,
    sourceConversationIds: uniqueStrings(
      provenance.map((version) => version.sourceConversationIds || []),
    ),
    sourceTaskIds: uniqueStrings(
      provenance.map((version) => version.sourceTaskIds || []),
    ),
    sourceMessageIds: uniqueStrings(
      provenance.map((version) => version.sourceMessageIds || []),
    ),
    sourceCheckpointIds: uniqueStrings(
      provenance.map((version) => version.sourceCheckpointIds || []),
    ),
    evidenceRefs: uniqueStrings(
      provenance.map((version) => version.evidenceRefs || []),
    ),
    updatedAt: latest.createdAt,
  };
}

function normalizeRecord(raw, sequenceState) {
  const source = raw && typeof raw === "object" ? raw : {};
  const id = String(source.id || "");
  if (!id || !source.scope) return null;
  const base = {
    id,
    revision: Math.max(1, Number(source.revision || 1)),
    scope: String(source.scope),
    scopeId: String(source.scopeId || "") || undefined,
    semanticKey: String(source.semanticKey || source.content || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300),
    createdAt: String(source.createdAt || source.updatedAt || nowIso()),
    content: String(source.content || ""),
    summary: String(source.summary || source.content || ""),
    status: normalizedStatus(source.status),
    kind: String(source.kind || "fact"),
    portability: String(source.portability || "universal"),
    authority: String(source.authority || "unknown"),
    confidence: Number(source.confidence ?? 0.5),
    sensitivity: normalizedSensitivity(source.sensitivity),
    source: String(source.source || "unknown"),
    sourceMessageIds: uniqueStrings(source.sourceMessageIds || []),
    sourceConversationIds: uniqueStrings(source.sourceConversationIds || []),
    sourceTaskIds: uniqueStrings(source.sourceTaskIds || []),
    sourceCheckpointIds: uniqueStrings(source.sourceCheckpointIds || []),
    sourceWorkspaceId: String(source.sourceWorkspaceId || "") || undefined,
    sourceAgentId: String(source.sourceAgentId || "") || undefined,
    sourceAgentSessionId: String(source.sourceAgentSessionId || "") || undefined,
    evidenceRefs: uniqueStrings(source.evidenceRefs || []),
    validUntil: String(source.validUntil || "") || undefined,
  };
  const incoming = Array.isArray(source.versions) && source.versions.length
    ? source.versions
    : [source];
  const versions = incoming.map((version) => {
    const explicitSequence = Number(version?.sequence || 0);
    if (explicitSequence > 0) {
      sequenceState.value = Math.max(sequenceState.value, explicitSequence);
      return normalizeVersion(version, base, explicitSequence);
    }
    sequenceState.value += 1;
    return normalizeVersion(version, base, sequenceState.value);
  });
  const record = {
    ...base,
    versions,
  };
  return projectRecord(record);
}

function scopeMatches(record, {
  projectId = "",
  conversationId = "",
  workspaceId = "",
  taskId = "",
  memoryMode = "project-and-global",
} = {}) {
  if (record.scope === "conversation") {
    return String(record.scopeId || "") === String(conversationId || "");
  }
  if (record.scope === "project") {
    return Boolean(projectId) && String(record.scopeId || "") === String(projectId);
  }
  if (record.scope === "user") return memoryMode !== "project-only";
  if (record.scope === "workspace") {
    return Boolean(workspaceId) && String(record.scopeId || "") === String(workspaceId);
  }
  if (record.scope === "task") {
    return Boolean(taskId) && String(record.scopeId || "") === String(taskId);
  }
  return false;
}

function canEnterModelContext(record, { includeSensitive = false } = {}) {
  if (!record?.content || record.status !== "active") return false;
  if (record.validUntil) {
    const expiresAt = Date.parse(record.validUntil);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return false;
  }
  if (!includeSensitive && record.sensitivity !== "normal") return false;
  if (looksLikeCredential(record.content)) return false;
  return true;
}

export function defaultMemoryDocument() {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    revision: 0,
    sequence: 0,
    updatedAt: "",
    overview: "",
    contextSettings: {
      conversationLimit: DEFAULT_CONTEXT_LIMIT,
      automaticCompressionThreshold: DEFAULT_COMPRESSION_THRESHOLD,
    },
    records: [],
    summaries: [],
    ledger: [],
  };
}

export function normalizeMemoryDocument(value) {
  const defaults = defaultMemoryDocument();
  const source = value && typeof value === "object" ? value : {};
  const threshold = Number(source.contextSettings?.automaticCompressionThreshold);
  const limit = Number(source.contextSettings?.conversationLimit);
  const sequenceState = { value: Math.max(0, Number(source.sequence || 0)) };
  const records = (Array.isArray(source.records) ? source.records : [])
    .map((record) => normalizeRecord(record, sequenceState))
    .filter(Boolean);
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    revision: Math.max(0, Number(source.revision || 0)),
    sequence: sequenceState.value,
    updatedAt: String(source.updatedAt || ""),
    overview: String(source.overview || ""),
    contextSettings: {
      conversationLimit:
        Number.isFinite(limit) && limit >= 8_000
          ? Math.floor(limit)
          : DEFAULT_CONTEXT_LIMIT,
      automaticCompressionThreshold:
        Number.isFinite(threshold) && threshold >= 0.5 && threshold <= 1
          ? threshold
          : DEFAULT_COMPRESSION_THRESHOLD,
    },
    records,
    summaries: Array.isArray(source.summaries) ? source.summaries : defaults.summaries,
    ledger: Array.isArray(source.ledger) ? source.ledger : defaults.ledger,
  };
}

export function estimateContextTokens(value) {
  const text = String(value || "");
  if (!text) return 0;
  const hanCount = (text.match(/[\p{Script=Han}]/gu) || []).length;
  const otherCount = text.length - hanCount;
  return Math.max(1, Math.ceil(hanCount * 0.72 + otherCount / 3.7));
}

export function findConversationSummary(document, conversationId) {
  return normalizeMemoryDocument(document).summaries
    .filter(
      (summary) =>
        summary?.scope === "conversation" &&
        String(summary.conversationId || "") === String(conversationId || "") &&
        summary.status !== "invalidated",
    )
    .sort((left, right) =>
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
    )[0];
}

export function upsertConversationSummary(
  document,
  {
    conversationId,
    content,
    checkpoint,
    throughMessageId,
    sourceMessageIds = [],
  },
) {
  const next = normalizeMemoryDocument(document);
  const timestamp = nowIso();
  const id = stableId("summary", `conversation:${conversationId}`);
  const previous = next.summaries.find((item) => item.id === id);
  const version = {
    versionId: stableId("summary_version", `${id}:${next.revision + 1}:${timestamp}`),
    content: String(content || "").trim().slice(0, 24_000),
    checkpoint:
      checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
        ? checkpoint
        : undefined,
    throughMessageId: String(throughMessageId || ""),
    sourceMessageIds: sourceMessageIds.map(String).slice(-400),
    status: "validated",
    createdAt: timestamp,
  };
  const summary = {
    id,
    scope: "conversation",
    conversationId: String(conversationId || ""),
    ...version,
    versions: [...(Array.isArray(previous?.versions) ? previous.versions : []), version],
    updatedAt: timestamp,
  };
  const index = next.summaries.findIndex((item) => item.id === id);
  if (index >= 0) next.summaries[index] = summary;
  else next.summaries.push(summary);
  next.revision += 1;
  next.updatedAt = timestamp;
  next.ledger.push({
    id: stableId("event", `${id}:${next.revision}:${timestamp}`),
    type: "context.compressed",
    conversationId: summary.conversationId,
    throughMessageId: summary.throughMessageId,
    sourceMessageIds: summary.sourceMessageIds,
    timestamp,
  });
  return next;
}

export function cloneConversationSummary(
  document,
  { sourceConversationId, targetConversationId, retainedMessageIds = [] },
) {
  const next = normalizeMemoryDocument(document);
  const source = findConversationSummary(next, sourceConversationId);
  if (!source || !retainedMessageIds.includes(String(source.throughMessageId || ""))) {
    return next;
  }
  return upsertConversationSummary(next, {
    conversationId: targetConversationId,
    content: source.content,
    checkpoint: source.checkpoint,
    throughMessageId: source.throughMessageId,
    sourceMessageIds: source.sourceMessageIds.filter((id) =>
      retainedMessageIds.includes(String(id)),
    ),
  });
}

export function cloneConversationMemoryScope(
  document,
  {
    sourceConversationId,
    targetConversationId,
    asOfSequence,
    snapshotVersionIds = [],
  },
) {
  let next = normalizeMemoryDocument(document);
  const sourceRecords = next.records
    .filter(
      (record) =>
        record.scope === "conversation" &&
        String(record.scopeId || "") === String(sourceConversationId || ""),
    )
    .map((record) =>
      projectRecord(record, { asOfSequence, snapshotVersionIds }),
    )
    .filter((record) => record.status === "active");
  for (const record of sourceRecords) {
    next = appendExplicitMemory(next, {
      content: record.content,
      summary: record.summary,
      scope: "conversation",
      scopeId: targetConversationId,
      kind: record.kind,
      semanticKey: record.semanticKey,
      source: "branch-memory-snapshot",
      sourceMessageIds: record.sourceMessageIds,
      sourceConversationId: targetConversationId,
      sourceWorkspaceId: record.sourceWorkspaceId,
      evidenceRefs: [
        ...(record.evidenceRefs || []),
        `memory:${record.id}:sequence:${record.sequence || 0}`,
      ],
      portability: record.portability,
      authority: record.authority,
      confidence: record.confidence,
      sensitivity: record.sensitivity,
      validUntil: record.validUntil,
    });
  }
  return next;
}

export function selectMemoryRecords(
  document,
  {
    prompt = "",
    projectId = "",
    conversationId = "",
    workspaceId = "",
    taskId = "",
    memoryMode = "project-and-global",
    limit = 16,
    relevanceThreshold = DEFAULT_RELEVANCE_THRESHOLD,
    asOfSequence,
    snapshotVersionIds = [],
    lineageConversationId = conversationId,
    includeSensitive = false,
  } = {},
) {
  const normalized = normalizeMemoryDocument(document);
  const queryTokens = textTokens(prompt);
  const scopeWeight = {
    conversation: 6,
    workspace: 5,
    project: 4,
    task: 7,
    user: 2,
  };
  return normalized.records
    .map((record) =>
      projectRecord(record, {
        asOfSequence,
        lineageConversationId,
        snapshotVersionIds,
      }),
    )
    .filter((record) => canEnterModelContext(record, { includeSensitive }))
    .filter((record) =>
      scopeMatches(record, {
        projectId,
        conversationId,
        workspaceId,
        taskId,
        memoryMode,
      }),
    )
    .map((record) => {
      const relevance = relevanceScore(`${record.summary}\n${record.content}`, queryTokens);
      return {
        ...record,
        _relevance: relevance,
        _score:
          (scopeWeight[record.scope] || 1) +
          relevance * 8 +
          Number(record.confidence || 0),
      };
    })
    .filter(
      (record) =>
        !queryTokens.size ||
        ["task", "conversation"].includes(record.scope) ||
        record._relevance >= Math.max(0, Number(relevanceThreshold || 0)),
    )
    .sort(
      (left, right) =>
        right._score - left._score ||
        Number(right.sequence || 0) - Number(left.sequence || 0),
    )
    .slice(0, Math.max(1, limit))
    .map((record) => {
      const result = { ...record };
      delete result._score;
      delete result._relevance;
      return result;
    });
}

export function selectMemorySyncRecords(
  document,
  {
    projectId = "",
    conversationId = "",
    workspaceId = "",
    taskId = "",
    memoryMode = "project-and-global",
    asOfSequence,
    snapshotVersionIds = [],
    lineageConversationId = conversationId,
  } = {},
) {
  return normalizeMemoryDocument(document).records
    .map((record) =>
      projectRecord(record, {
        asOfSequence,
        lineageConversationId,
        snapshotVersionIds,
      }),
    )
    .filter((record) =>
      scopeMatches(record, {
        projectId,
        conversationId,
        workspaceId,
        taskId,
        memoryMode,
      }),
    )
    .map((record) =>
      record.status === "active" && !canEnterModelContext(record)
        ? {
            ...record,
            status: "deleted",
            revision: Number(record.revision || 0) + 0.5,
            source: "memory-outbound-policy",
          }
        : record,
    )
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

export function currentConversationHistory(
  state,
  conversationId,
  { beforeMessageId = "", afterMessageId = "", maxMessages = 18 } = {},
) {
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  if (!conversation) return [];
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const endIndex = beforeMessageId
    ? messages.findIndex((message) => message.id === beforeMessageId)
    : messages.length;
  const boundedEnd = endIndex < 0 ? messages.length : endIndex;
  const afterIndex = afterMessageId
    ? messages.findIndex((message) => message.id === afterMessageId)
    : -1;
  return messages
    .slice(Math.max(0, afterIndex + 1), boundedEnd)
    .filter((message) => message?.content)
    .slice(-Math.max(1, maxMessages))
    .map((message) => ({
      id: String(message.id || ""),
      role: message.role === "user" ? "user" : "assistant",
      content: String(message.content || ""),
      createdAt: String(message.createdAt || ""),
      agentId: message.agentId ? String(message.agentId) : undefined,
      runId: message.runId ? String(message.runId) : undefined,
      workspaceId: message.workspaceId
        ? String(message.workspaceId)
        : undefined,
      workspaceName: message.workspaceName
        ? String(message.workspaceName)
        : undefined,
    }));
}

export function agentConversationDelta(
  state,
  conversationId,
  binding,
  { currentUserMessageId = "", maxMessages = 24 } = {},
) {
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const cursorId = String(binding?.syncCursor?.lastMessageId || "");
  const cursorIndex = cursorId
    ? messages.findIndex((message) => String(message.id) === cursorId)
    : -1;
  const endIndex = currentUserMessageId
    ? messages.findIndex(
        (message) => String(message.id) === String(currentUserMessageId),
      )
    : messages.length - 1;
  const boundedEnd = endIndex < 0 ? messages.length : endIndex;
  const deliveredHashes = new Set(binding?.syncCursor?.deliveredContentHashes || []);
  const deliveredTaskIds = new Set(binding?.syncCursor?.deliveredTaskIds || []);
  const candidates = messages
    .slice(cursorIndex + 1, Math.max(cursorIndex + 1, boundedEnd))
    .filter((message) => message?.content)
    .map((message) => ({
      id: String(message.id || ""),
      role: message.role === "user" ? "user" : "assistant",
      content: String(message.content || ""),
      agentId: message.agentId ? String(message.agentId) : undefined,
      runId: message.runId ? String(message.runId) : undefined,
      workspaceId: message.workspaceId
        ? String(message.workspaceId)
        : undefined,
      workspaceName: message.workspaceName
        ? String(message.workspaceName)
        : undefined,
      contentFingerprint: contentFingerprint(
        `${message.role === "user" ? "user" : "assistant"}\u0000${message.content}`,
      ),
    }))
    .filter(
      (message) =>
        cursorIndex >= 0 ||
        (!deliveredHashes.has(message.contentFingerprint) &&
          (!message.runId || !deliveredTaskIds.has(message.runId))),
    );
  const delta = candidates.slice(-Math.max(1, maxMessages));
  return {
    bootstrap: !binding?.agentSessionId,
    cursorId,
    truncated:
      (Boolean(cursorId) && cursorIndex < 0) || candidates.length > delta.length,
    messages: delta,
  };
}

export function appendExplicitMemory(
  document,
  {
    content,
    summary = "",
    scope = "user",
    scopeId = "",
    kind = "preference",
    semanticKey = "",
    source = "user",
    sourceMessageIds = [],
    sourceConversationId,
    sourceTaskId,
    sourceCheckpointId,
    sourceWorkspaceId,
    sourceAgentId,
    sourceAgentSessionId,
    evidenceRefs = [],
    portability = scope === "workspace" ? "workspace-bound" : "universal",
    authority = "user-explicit",
    confidence = 1,
    sensitivity = "normal",
    validUntil = "",
    status = "active",
  },
) {
  const next = normalizeMemoryDocument(document);
  const normalizedContent = String(content || "").trim().slice(0, 2_000);
  if (!normalizedContent) return next;
  const normalizedScopeId = String(scopeId || "");
  const normalizedSemanticKey = String(semanticKey || normalizedContent)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  const identity = [scope, normalizedScopeId, normalizedSemanticKey].join("\u0000");
  const candidateId = stableId("memory", identity);
  const fingerprint = contentFingerprint(normalizedContent);
  const existingIndex = next.records.findIndex(
    (record) =>
      record.id === candidateId ||
      (record.scope === scope &&
        String(record.scopeId || "") === normalizedScopeId &&
        record.status === "active" &&
        record.contentFingerprint === fingerprint),
  );
  const existing = existingIndex >= 0 ? next.records[existingIndex] : null;
  const id = existing?.id || candidateId;
  const timestamp = nowIso();
  next.sequence += 1;
  const revision = Number(existing?.revision || 0) + 1;
  const version = normalizeVersion(
    {
      revision,
      sequence: next.sequence,
      status,
      content: normalizedContent,
      summary: String(summary || normalizedContent).trim().slice(0, 800),
      kind,
      portability,
      authority,
      confidence,
      sensitivity,
      validUntil,
      source,
      sourceMessageIds,
      sourceConversationId,
      sourceTaskId,
      sourceCheckpointId,
      sourceWorkspaceId,
      sourceAgentId,
      sourceAgentSessionId,
      evidenceRefs,
      createdAt: timestamp,
    },
    { id, ...existing },
    next.sequence,
  );
  const record = projectRecord({
    id,
    revision,
    scope,
    scopeId: normalizedScopeId || undefined,
    semanticKey: existing?.semanticKey || normalizedSemanticKey,
    createdAt: existing?.createdAt || timestamp,
    versions: [...(existing?.versions || []), version],
  });
  if (existingIndex >= 0) next.records[existingIndex] = record;
  else next.records.unshift(record);
  next.revision += 1;
  next.updatedAt = timestamp;
  next.ledger.push({
    id: stableId("event", `${id}:${revision}:${timestamp}`),
    type: existingIndex >= 0 ? "memory.revised" : "memory.created",
    memoryId: id,
    versionId: version.versionId,
    revision,
    sequence: version.sequence,
    sourceConversationId: version.sourceConversationId,
    sourceTaskId: version.sourceTaskId,
    timestamp,
  });
  return next;
}

export function appendMemoryTombstone(
  document,
  { memoryId, reason = "用户删除", source = "user", sourceConversationId = "" },
) {
  const next = normalizeMemoryDocument(document);
  const index = next.records.findIndex((record) => record.id === memoryId);
  if (index < 0) return next;
  const existing = next.records[index];
  const timestamp = nowIso();
  next.sequence += 1;
  const revision = Number(existing.revision || 0) + 1;
  const version = normalizeVersion(
    {
      revision,
      sequence: next.sequence,
      status: "deleted",
      content: existing.content,
      summary: reason,
      source,
      sourceConversationId,
      createdAt: timestamp,
    },
    existing,
    next.sequence,
  );
  next.records[index] = projectRecord({
    ...existing,
    revision,
    versions: [...(existing.versions || []), version],
  });
  next.revision += 1;
  next.updatedAt = timestamp;
  next.ledger.push({
    id: stableId("event", `${memoryId}:${revision}:${timestamp}`),
    type: "memory.deleted",
    memoryId,
    versionId: version.versionId,
    revision,
    sequence: version.sequence,
    reason,
    timestamp,
  });
  return next;
}

export function invalidateMemoryVersions(
  document,
  {
    sourceConversationIds = [],
    sourceTaskIds = [],
    sourceMessageIds = [],
    afterSequence,
    afterTimestamp = "",
    reason = "source-reset",
    invalidatedBy = "system",
  } = {},
) {
  const next = normalizeMemoryDocument(document);
  const conversationSet = new Set(sourceConversationIds.filter(Boolean).map(String));
  const taskSet = new Set(sourceTaskIds.filter(Boolean).map(String));
  const messageSet = new Set(sourceMessageIds.filter(Boolean).map(String));
  const timestamp = nowIso();
  const affected = [];
  for (let recordIndex = 0; recordIndex < next.records.length; recordIndex += 1) {
    const record = next.records[recordIndex];
    let touched = false;
    const invalidatedSequence = next.sequence + 1;
    const versions = (record.versions || []).map((version) => {
      if (version.invalidatedAt) return version;
      const conversationMatches =
        !conversationSet.size ||
        conversationSet.has(String(version.sourceConversationId || "")) ||
        (version.sourceConversationIds || []).some((id) => conversationSet.has(String(id)));
      const taskMatches =
        !taskSet.size ||
        taskSet.has(String(version.sourceTaskId || "")) ||
        (version.sourceTaskIds || []).some((id) => taskSet.has(String(id)));
      const messageMatches =
        !messageSet.size ||
        (version.sourceMessageIds || []).some((id) => messageSet.has(String(id)));
      const sequenceMatches =
        !Number.isFinite(Number(afterSequence)) ||
        Number(version.sequence || 0) > Number(afterSequence);
      const timeMatches =
        !afterTimestamp ||
        String(version.createdAt || "").localeCompare(String(afterTimestamp)) > 0;
      if (
        conversationMatches &&
        taskMatches &&
        messageMatches &&
        sequenceMatches &&
        timeMatches
      ) {
        touched = true;
        affected.push(version.versionId);
        return {
          ...version,
          invalidatedAt: timestamp,
          invalidatedSequence,
          invalidatedReason: reason,
          invalidatedBy,
        };
      }
      return version;
    });
    if (touched) {
      next.sequence = invalidatedSequence;
      next.records[recordIndex] = projectRecord({
        ...record,
        revision: Number(record.revision || 0) + 1,
        versions,
        lastMutationSequence: next.sequence,
      });
    }
  }
  if (!affected.length) return next;
  next.revision += 1;
  next.updatedAt = timestamp;
  next.ledger.push({
    id: stableId("event", `invalidate:${next.revision}:${timestamp}`),
    type: "memory.versions-invalidated",
    affectedVersionIds: affected,
    sourceConversationIds: [...conversationSet],
    sourceTaskIds: [...taskSet],
    sourceMessageIds: [...messageSet],
    afterSequence: Number.isFinite(Number(afterSequence))
      ? Number(afterSequence)
      : undefined,
    afterTimestamp: afterTimestamp || undefined,
    reason,
    invalidatedBy,
    timestamp,
  });
  return next;
}

export function memorySnapshotAt(
  document,
  timestamp,
  { sourceMessageIds = [], sourceTaskIds = [] } = {},
) {
  const target = String(timestamp || "");
  const messageSet = new Set(sourceMessageIds.filter(Boolean).map(String));
  const taskSet = new Set(sourceTaskIds.filter(Boolean).map(String));
  const normalized = normalizeMemoryDocument(document);
  if (!target && !messageSet.size && !taskSet.size) {
    return { sequence: normalized.sequence, versionIds: [] };
  }
  let sequence = 0;
  const versionIds = [];
  for (const record of normalized.records) {
    for (const version of record.versions || []) {
      const beforeTime =
        target && String(version.createdAt || "").localeCompare(target) <= 0;
      const sourcedByMessage = (version.sourceMessageIds || []).some((id) =>
        messageSet.has(String(id)),
      );
      const sourcedByTask =
        taskSet.has(String(version.sourceTaskId || "")) ||
        (version.sourceTaskIds || []).some((id) => taskSet.has(String(id)));
      if (beforeTime) {
        sequence = Math.max(sequence, Number(version.sequence || 0));
      }
      if (sourcedByMessage || sourcedByTask) {
        versionIds.push(String(version.versionId || ""));
      }
    }
  }
  return {
    sequence,
    versionIds: [...new Set(versionIds.filter(Boolean))],
  };
}

export function activeMemoryRecords(document) {
  return normalizeMemoryDocument(document).records
    .map((record) => projectRecord(record))
    .filter((record) => record.status === "active");
}
