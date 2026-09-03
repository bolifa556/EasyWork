export const INTERNAL_VERSION_HOOK_STATUS = "__easywork_internal_version_snapshot__";
export const VERSION_HOOK_REVISION = "2026-09-01.2";

export function versionHookPaths(paths) {
  const root = `${paths.runtimeState}/version-hooks`;
  return Object.freeze({
    root,
    launcher: `${paths.runtimeState}/easywork-version-pretool.sh`,
    script: `${paths.runtimeState}/easywork-version-pretool.py`,
    activeTask: `${root}/active-task`,
    sessionTasks: `${root}/session-tasks`,
  });
}

export function versionHookCommand(paths) {
  const hook = versionHookPaths(paths);
  const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  // Keep the implementation revision in the configured command so Codex's
  // hook hash changes when the parser changes. Its scoped trust refresh then
  // hot-reloads already opened native threads instead of leaving them on an
  // older in-memory hook definition.
  return `EASYWORK_VERSION_HOOK_REVISION=${quote(VERSION_HOOK_REVISION)} sh ${quote(hook.launcher)} ${quote(hook.script)} ${quote(hook.root)}`;
}

export function versionHookCheckCommand(paths) {
  const hook = versionHookPaths(paths);
  const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  return `sh ${quote(hook.launcher)} --check ${quote(hook.script)} ${quote(hook.root)}`;
}

export const VERSION_PRETOOL_LAUNCHER = `#!/bin/sh
check_only=0
if [ "\${1:-}" = "--check" ]; then
  check_only=1
  shift
fi

script=\${1:-}
hook_root=\${2:-}

fail() {
  printf '%s\\n' "EasyWork could not capture file state: no usable Python 3 runtime was found." >&2
  exit 2
}

if [ -z "$script" ] || [ -z "$hook_root" ] || [ ! -r "$script" ] || [ ! -d "$hook_root" ]; then
  fail
fi

use_python() {
  candidate=$1
  case "$candidate" in
    /*) resolved=$candidate ;;
    *) resolved=$(command -v "$candidate" 2>/dev/null || true) ;;
  esac
  [ -n "$resolved" ] && [ -x "$resolved" ] || return 1
  "$resolved" -c 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1 || return 1
  if [ "$check_only" -eq 1 ]; then
    exit 0
  fi
  exec "$resolved" "$script" "$hook_root"
}

if [ -n "\${EASYWORK_PYTHON3:-}" ]; then
  use_python "$EASYWORK_PYTHON3" || fail
fi

ssh_home=
case "$script" in
  */.easywork/*) ssh_home=\${script%%/.easywork/*} ;;
esac

for candidate in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/conda/bin/python3 "\${ssh_home:+$ssh_home/miniconda3/bin/python3}" "\${ssh_home:+$ssh_home/anaconda3/bin/python3}" /public/software/apps/anaconda3/*/bin/python3 /public/software/apps/anaconda/*/bin/python3 /public/software/apps/python/*/bin/python3 python
do
  [ -n "$candidate" ] || continue
  use_python "$candidate" || true
done

fail
`;

export const VERSION_PRETOOL_PYTHON = String.raw`#!/usr/bin/env python3
import ast
import hashlib
import glob
import json
import os
import pathlib
import re
import shlex
import shutil
import stat
import sys
import tempfile
import time


def stop(message):
    sys.stderr.write("EasyWork could not capture the file state before this operation: " + str(message) + "\n")
    raise SystemExit(2)


def values(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(item) for item in value if isinstance(item, (str, int, float))]
    return []


def preserve_shell_statement_boundaries(command):
    # shlex treats newlines as ordinary whitespace.  In a shell script they
    # terminate commands unless quoted or escaped, so dropping them can merge
    # rm target + newline + cd workspace + newline + find previously became
    # one synthetic rm operand list.  That made a read-only find expression
    # using -path ./.git -prune look like an
    # attempt to delete .git and rejected the whole OpenCode permission.
    result = []
    quote = None
    escaped = False
    for character in str(command):
        if escaped:
            result.append(character)
            escaped = False
            continue
        if character == "\\" and quote != "'":
            result.append(character)
            escaped = True
            continue
        if quote:
            result.append(character)
            if character == quote:
                quote = None
            continue
        if character in ("'", '"'):
            quote = character
            result.append(character)
            continue
        if character in ("\r", "\n"):
            result.append(" ; ")
            continue
        result.append(character)
    return "".join(result)


def shell_tokens(command):
    try:
        lexer = shlex.shlex(preserve_shell_statement_boundaries(command), posix=True, punctuation_chars=";&|<>")
        lexer.whitespace_split = True
        lexer.commenters = ""
        return list(lexer)
    except ValueError:
        return []


def standard_output_sink(value):
    target = str(value or "").strip().strip("'\"").rstrip(";,)")
    return target in ("/dev/null", "/dev/stdout", "/dev/stderr") or target.startswith("/dev/fd/") or target.startswith("/proc/self/fd/")


def strip_heredoc_bodies(command):
    pattern = re.compile(r"<<(-?)(?!<)\s*(?:'([^'\r\n]+)'|\"([^\"\r\n]+)\"|([A-Za-z0-9_][A-Za-z0-9_.-]*))")
    pending = []
    output = []
    for line in str(command).splitlines(True):
        if pending:
            delimiter, strip_tabs = pending[0]
            candidate = line.rstrip("\r\n")
            if strip_tabs:
                candidate = candidate.lstrip("\t")
            if candidate == delimiter:
                pending.pop(0)
            output.append("\n" if line.endswith(("\n", "\r")) else "")
            continue
        output.append(line)
        for match in pattern.finditer(line):
            delimiter = match.group(2) or match.group(3) or match.group(4)
            if delimiter:
                pending.append((delimiter, match.group(1) == "-"))
    return "".join(output)


def heredoc_blocks(command):
    pattern = re.compile(r"<<(-?)(?!<)\s*(?:'([^'\r\n]+)'|\"([^\"\r\n]+)\"|([A-Za-z0-9_][A-Za-z0-9_.-]*))")
    lines = str(command).splitlines()
    blocks = []
    index = 0
    while index < len(lines):
        match = pattern.search(lines[index])
        if not match:
            index += 1
            continue
        delimiter = match.group(2) or match.group(3) or match.group(4)
        strip_tabs = match.group(1) == "-"
        body = []
        cursor = index + 1
        while cursor < len(lines):
            candidate = lines[cursor].lstrip("\t") if strip_tabs else lines[cursor]
            if candidate == delimiter or candidate in (delimiter + "\"", delimiter + "'"):
                break
            body.append(lines[cursor])
            cursor += 1
        if cursor < len(lines):
            blocks.append((lines[index][:match.start()], "\n".join(body)))
            index = cursor + 1
        else:
            index += 1
    return blocks


def python_heredoc_header(header):
    return bool(re.search(
        r"(?:^|[\s;&|\"'])(?:/[^\s;&|\"']+/)?python(?:\d+(?:\.\d+)*)?\s+[^<\r\n]*$",
        str(header or "").strip(), re.IGNORECASE))


def python_literal_path(node, bindings):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.Call):
        function = node.func
        path_constructor = isinstance(function, ast.Name) and function.id == "Path"
        path_constructor = path_constructor or (isinstance(function, ast.Attribute) and function.attr == "Path")
        if path_constructor and node.args:
            return python_literal_path(node.args[0], bindings)
        if (isinstance(function, ast.Attribute) and function.attr == "join"
                and isinstance(function.value, ast.Attribute) and function.value.attr == "path"):
            values = [python_literal_path(argument, bindings) for argument in node.args]
            if values and all(value is not None for value in values):
                return os.path.join(*values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        left = python_literal_path(node.left, bindings)
        right = python_literal_path(node.right, bindings)
        if left is not None and right is not None:
            return os.path.join(left, right)
    return None


def python_mode(call, position=1):
    candidate = call.args[position] if len(call.args) > position else None
    for keyword in call.keywords:
        if keyword.arg == "mode":
            candidate = keyword.value
    if isinstance(candidate, ast.Constant) and isinstance(candidate.value, str):
        return candidate.value
    return "r"


def python_write_paths(source):
    try:
        tree = ast.parse(str(source or ""))
    except (SyntaxError, ValueError):
        return []
    bindings = {}
    assignments = [node for node in ast.walk(tree) if isinstance(node, (ast.Assign, ast.AnnAssign))]
    for _ in range(len(assignments) + 1):
        changed = False
        for assignment in assignments:
            targets = assignment.targets if isinstance(assignment, ast.Assign) else [assignment.target]
            value = python_literal_path(assignment.value, bindings)
            if value is None:
                continue
            for target in targets:
                if isinstance(target, ast.Name) and bindings.get(target.id) != value:
                    bindings[target.id] = value
                    changed = True
        if not changed:
            break
    path_methods = {"write_text", "write_bytes", "unlink", "mkdir", "touch", "chmod", "rename", "replace", "symlink_to", "hardlink_to"}
    os_functions = {"remove", "unlink", "rmdir", "mkdir", "makedirs", "chmod", "chown", "rename", "replace"}
    shutil_functions = {"rmtree", "copyfile", "copy", "copy2", "move"}
    function_definitions = {
        node.name: node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    def parameter_reference(node, parameters):
        if isinstance(node, ast.Name) and node.id in parameters:
            return parameters.index(node.id)
        if (isinstance(node, ast.Call) and node.args
                and ((isinstance(node.func, ast.Name) and node.func.id == "Path")
                     or (isinstance(node.func, ast.Attribute) and node.func.attr == "Path"))):
            return parameter_reference(node.args[0], parameters)
        return None

    def call_argument(call, definition, position):
        if len(call.args) > position:
            return call.args[position]
        parameters = [argument.arg for argument in definition.args.args]
        if position >= len(parameters):
            return None
        return next((keyword.value for keyword in call.keywords if keyword.arg == parameters[position]), None)

    # Agents commonly centralize pathlib writes in a helper such as
    # replay(path, transform). Resolve which helper parameters can mutate a
    # path, then propagate literal Path arguments through those calls. This
    # remains deliberately static: dynamic/eval-derived targets are ignored.
    function_mutations = {name: set() for name in function_definitions}
    for _ in range(len(function_definitions) + 1):
        changed = False
        for name, definition in function_definitions.items():
            parameters = [argument.arg for argument in definition.args.args]
            discovered = set(function_mutations[name])
            for call in (node for node in ast.walk(definition) if isinstance(node, ast.Call)):
                function = call.func
                if isinstance(function, ast.Name) and function.id == "open":
                    if call.args and any(flag in python_mode(call) for flag in ("w", "a", "x", "+")):
                        position = parameter_reference(call.args[0], parameters)
                        if position is not None:
                            discovered.add(position)
                    continue
                if isinstance(function, ast.Name) and function.id in function_mutations:
                    target_definition = function_definitions[function.id]
                    for target_position in function_mutations[function.id]:
                        argument = call_argument(call, target_definition, target_position)
                        position = parameter_reference(argument, parameters)
                        if position is not None:
                            discovered.add(position)
                    continue
                if not isinstance(function, ast.Attribute):
                    continue
                owner_position = parameter_reference(function.value, parameters)
                if owner_position is not None and function.attr in path_methods:
                    discovered.add(owner_position)
                module = function.value.id if isinstance(function.value, ast.Name) else ""
                argument_positions = (
                    (0, 1) if function.attr in ("rename", "replace", "move")
                    else (1,) if function.attr in ("copyfile", "copy", "copy2")
                    else (0,)
                )
                if ((module == "os" and function.attr in os_functions)
                        or (module == "shutil" and function.attr in shutil_functions)):
                    for argument_position in argument_positions:
                        if len(call.args) > argument_position:
                            position = parameter_reference(call.args[argument_position], parameters)
                            if position is not None:
                                discovered.add(position)
            if discovered != function_mutations[name]:
                function_mutations[name] = discovered
                changed = True
        if not changed:
            break

    result = []
    for call in (node for node in ast.walk(tree) if isinstance(node, ast.Call)):
        function = call.func
        if isinstance(function, ast.Name) and function.id in function_mutations:
            definition = function_definitions[function.id]
            for position in function_mutations[function.id]:
                argument = call_argument(call, definition, position)
                target = python_literal_path(argument, bindings) if argument is not None else None
                if target is not None:
                    result.append(target)
            continue
        if isinstance(function, ast.Name) and function.id == "open":
            if call.args and any(flag in python_mode(call) for flag in ("w", "a", "x", "+")):
                target = python_literal_path(call.args[0], bindings)
                if target is not None:
                    result.append(target)
            continue
        if not isinstance(function, ast.Attribute):
            continue
        owner = python_literal_path(function.value, bindings)
        if owner is not None and function.attr == "open":
            if any(flag in python_mode(call, 0) for flag in ("w", "a", "x", "+")):
                result.append(owner)
            continue
        if owner is not None and function.attr in path_methods:
            result.append(owner)
            if function.attr in ("rename", "replace") and call.args:
                destination = python_literal_path(call.args[0], bindings)
                if destination is not None:
                    result.append(destination)
            continue
        module = function.value.id if isinstance(function.value, ast.Name) else ""
        arguments = [python_literal_path(argument, bindings) for argument in call.args]
        if module == "os" and function.attr in os_functions:
            positions = (0, 1) if function.attr in ("rename", "replace") else (0,)
            result.extend(arguments[position] for position in positions if len(arguments) > position and arguments[position] is not None)
        elif module == "shutil" and function.attr in shutil_functions:
            if function.attr == "move":
                positions = (0, 1)
            elif function.attr in ("copyfile", "copy", "copy2"):
                positions = (1,)
            else:
                positions = (0,)
            result.extend(arguments[position] for position in positions if len(arguments) > position and arguments[position] is not None)
    return result


def python_heredoc_paths(command, depth=0):
    if depth > 3:
        return []
    result = []
    for header, body in heredoc_blocks(command):
        if python_heredoc_header(header):
            result.extend(python_write_paths(body))
    tokens = shell_tokens(command)
    if tokens:
        command_index = 0
        while command_index < len(tokens) and tokens[command_index] in ("sudo", "env", "command", "builtin", "nohup", "time"):
            command_index += 1
        if command_index < len(tokens) and os.path.basename(tokens[command_index]) in ("bash", "sh", "zsh", "dash"):
            arguments = tokens[command_index + 1:]
            for flag in ("-c", "-lc", "-cl"):
                if flag in arguments and arguments.index(flag) + 1 < len(arguments):
                    result.extend(python_heredoc_paths(arguments[arguments.index(flag) + 1], depth + 1))
                    break
    return result


def without_shell_redirections(tokens):
    # shlex separates 2>/dev/null into the tokens 2, >, /dev/null. Redirects
    # must remain visible to the redirect scanner above, but they are syntax,
    # not operands of the surrounding cp/mv/chmod command.  Leaving the sink
    # in the operand list can turn /dev/null into the apparent cp target and
    # make the snapshotter reject its character-device type.
    result = []
    index = 0
    redirect = re.compile(r"(?:>{1,2}|<{1,3}|<>|>&|<&)\Z")
    combined = re.compile(r"\d*(?:>{1,2}|<{1,3}|<>|>&|<&)\Z")
    while index < len(tokens):
        token = tokens[index]
        operator_index = None
        if re.fullmatch(r"\d+", token) and index + 1 < len(tokens) and redirect.fullmatch(tokens[index + 1]):
            operator_index = index + 1
        elif redirect.fullmatch(token) or combined.fullmatch(token):
            operator_index = index
        if operator_index is None:
            result.append(token)
            index += 1
            continue
        index = operator_index + 1
        if index < len(tokens) and tokens[index] == "&":
            index += 1
        if index < len(tokens):
            index += 1
    return result


def shell_paths(command, depth=0):
    if depth > 3:
        return []
    raw_command = str(command)
    # Codex can expose apply_patch through a shell command.  Its heredoc body
    # is data, not shell syntax: capture the patch headers explicitly and keep
    # redirects/comparisons inside the proposed file content out of the shell
    # parser.
    result = patch_paths(raw_command) if re.search(r"\bapply_patch\b[^\r\n]*<<", raw_command) else []
    result.extend(python_heredoc_paths(raw_command))
    tokens = shell_tokens(strip_heredoc_bodies(raw_command))
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in (">", ">>", "<>") and index + 1 < len(tokens):
            target = tokens[index + 1]
            if not standard_output_sink(target):
                result.append(target)
            index += 2
            continue
        if re.fullmatch(r"\d*(?:>|>>|<>)", token) and index + 1 < len(tokens):
            target = tokens[index + 1]
            if not standard_output_sink(target):
                result.append(target)
            index += 2
            continue
        index += 1

    tokens = without_shell_redirections(tokens)
    separators = {";", "&&", "||", "|", "&"}
    segments = []
    current = []
    for token in tokens:
        if token in separators:
            if current:
                segments.append(current)
                current = []
        else:
            current.append(token)
    if current:
        segments.append(current)

    wrappers = {"sudo", "env", "command", "builtin", "nohup", "time"}
    mutators = {"rm", "unlink", "rmdir", "mv", "cp", "install", "touch", "mkdir", "truncate", "tee", "ln", "chmod", "chown", "chgrp"}
    for segment in segments:
        command_index = 0
        while command_index < len(segment) and (segment[command_index] in wrappers or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", segment[command_index])):
            command_index += 1
        if command_index >= len(segment):
            continue
        executable = os.path.basename(segment[command_index])
        arguments = segment[command_index + 1:]
        if executable in ("bash", "sh", "zsh", "dash"):
            for flag in ("-c", "-lc", "-cl"):
                if flag in arguments:
                    nested = arguments.index(flag) + 1
                    if nested < len(arguments):
                        result.extend(shell_paths(arguments[nested], depth + 1))
                    break
            continue
        if executable in mutators:
            if executable in ("chmod", "chown", "chgrp"):
                # The first non-option operand is the mode/owner/group spec;
                # everything after it is a path.  Keep numeric modes here:
                # the generic operand parser deliberately ignores bare
                # numbers for commands such as truncate -s 0 file.
                control_options = {
                    "-R", "--recursive", "-f", "--silent", "--quiet",
                    "-v", "--verbose", "-c", "--changes", "-H", "-L", "-P",
                    "--preserve-root", "--no-preserve-root",
                }
                permission_operands = []
                permission_index = 0
                while permission_index < len(arguments):
                    argument = arguments[permission_index]
                    if argument == "--":
                        permission_operands.extend(arguments[permission_index + 1:])
                        break
                    if argument in ("--reference", "--from") and permission_index + 1 < len(arguments):
                        permission_index += 2
                        continue
                    if argument.startswith("--reference=") or argument.startswith("--from=") or argument in control_options:
                        permission_index += 1
                        continue
                    permission_operands.append(argument)
                    permission_index += 1
                if len(permission_operands) > 1:
                    result.extend(permission_operands[1:])
                continue
            target_directory = None
            operands = []
            skip = False
            for position, argument in enumerate(arguments):
                if skip:
                    skip = False
                    continue
                if argument in ("-t", "--target-directory") and position + 1 < len(arguments):
                    target_directory = arguments[position + 1]
                    skip = True
                    continue
                if argument.startswith("--target-directory="):
                    target_directory = argument.split("=", 1)[1]
                    continue
                if argument.startswith("-") or re.fullmatch(r"\d+", argument):
                    continue
                operands.append(argument)
            if target_directory:
                result.append(target_directory)
            if executable in ("cp", "install", "ln"):
                if not target_directory and operands:
                    result.append(operands[-1])
            elif executable == "mv":
                result.extend(operands)
            else:
                result.extend(operands)
        elif executable in ("sed", "perl") and any(
                argument == "--in-place"
                or argument.startswith("--in-place=")
                or (argument.startswith("-") and not argument.startswith("--") and "i" in argument[1:])
                for argument in arguments):
            explicit_program = False
            implicit_program_seen = False
            position = 0
            while position < len(arguments):
                argument = arguments[position]
                if argument == "--":
                    operands = arguments[position + 1:]
                    if not explicit_program and not implicit_program_seen and operands:
                        operands = operands[1:]
                    result.extend(operands)
                    break
                if argument in ("-e", "--expression", "-f", "--file"):
                    explicit_program = True
                    position += 2
                    continue
                if (argument.startswith("--expression=") or argument.startswith("--file=")
                        or re.match(r"^-[ef].+", argument)):
                    explicit_program = True
                    position += 1
                    continue
                if argument.startswith("-"):
                    position += 1
                    continue
                if explicit_program or implicit_program_seen:
                    result.append(argument)
                else:
                    implicit_program_seen = True
                position += 1
        elif executable == "dd":
            result.extend(argument.split("=", 1)[1] for argument in arguments if argument.startswith("of=") and len(argument) > 3)
        elif executable in ("rsync", "scp"):
            operands = [argument for argument in arguments if not argument.startswith("-")]
            if operands:
                result.append(operands[-1].split(":", 1)[-1])
        elif executable in ("unzip", "tar"):
            for flag in ("-d", "-C", "--directory"):
                if flag in arguments and arguments.index(flag) + 1 < len(arguments):
                    result.append(arguments[arguments.index(flag) + 1])
        elif executable in ("python", "python3") and ("-c" in arguments or "-m" not in arguments):
            source = arguments[arguments.index("-c") + 1] if "-c" in arguments and arguments.index("-c") + 1 < len(arguments) else ""
            for match in re.finditer(r"(?:^|[^.A-Za-z0-9_])open\(\s*(['\"])(.+?)\1\s*(?:,\s*(['\"])([^'\"]*)\3)?", source):
                mode = match.group(4) or "r"
                if any(flag in mode for flag in ("w", "a", "x", "+")):
                    result.append(match.group(2))
            for match in re.finditer(r"Path\(\s*(['\"])(.+?)\1\s*\)\.open\(\s*(['\"])([^'\"]*)\3", source):
                if any(flag in match.group(4) for flag in ("w", "a", "x", "+")):
                    result.append(match.group(2))
            result.extend(re.findall(r"Path\(\s*['\"](.+?)['\"]\s*\)\.(?:write_text|write_bytes|unlink|mkdir|rename|replace)", source))
    return result


def patch_paths(text):
    return [match.group(1).strip() for match in re.finditer(r"^\*\*\* (?:Add|Update|Delete|Move) File:\s*(.+)$", str(text), re.MULTILINE)]


def easywork_workspace_root(value):
    parts = pathlib.Path(os.path.realpath(value)).parts
    for index in range(len(parts) - 1):
        if parts[index] == ".easywork" and parts[index + 1] == "workspaces":
            return os.path.realpath(os.path.join(*parts[:index + 2]))
    return None


def candidates(tool_name, tool_input):
    result = []
    normalized_name = str(tool_name or "").lower()
    direct_file_tool = any(word in normalized_name for word in ("write", "edit", "patch", "create", "delete", "remove", "move", "copy", "rename", "notebook"))
    shell_tool = any(word in normalized_name for word in ("bash", "shell", "exec", "command", "terminal"))
    if isinstance(tool_input, dict):
        if direct_file_tool:
            for key in ("path", "file_path", "filePath", "notebook_path", "notebookPath", "destination", "target"):
                result.extend(values(tool_input.get(key)))
            for key in ("paths", "files"):
                result.extend(values(tool_input.get(key)))
            for change in tool_input.get("changes", []) if isinstance(tool_input.get("changes"), list) else []:
                if isinstance(change, dict):
                    result.extend(values(change.get("path") or change.get("file_path") or change.get("filePath")))
            patch = tool_input.get("patch") or tool_input.get("diff")
            if patch:
                result.extend(patch_paths(patch))
        if shell_tool:
            command = tool_input.get("command")
            if command:
                if isinstance(command, list):
                    command = " ".join(shlex.quote(str(part)) for part in command)
                result.extend(shell_paths(command))
    return result


def absolute_path(candidate, cwd):
    source = str(candidate or "").strip().strip("'\"").rstrip(";,)")
    if not source or source.startswith("-") or "\x00" in source or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", source):
        return None
    if source.startswith("~"):
        source = os.path.expanduser(source)
    source = os.path.expandvars(source)
    if "$" in source or chr(96) in source or "*(" in source or any(character in source for character in ("*", "?", "[", "]")):
        return None
    lexical = os.path.normpath(source if os.path.isabs(source) else os.path.join(cwd, source))
    if os.path.islink(lexical):
        stop("symbolic links are not versioned: " + lexical)
    target = os.path.realpath(lexical)
    if target == "/":
        stop("the filesystem root is not versioned")
    parts = pathlib.Path(target).parts
    if ".git" in parts:
        stop("Git control files are not versioned: " + target)
    if ".easywork" in parts:
        # Each native Agent receives an isolated HOME, while its working tree
        # intentionally remains under the SSH account's ~/.easywork/workspaces.
        # Derive that stable root from cwd instead of the process HOME so the
        # isolation boundary cannot make legitimate workspace files look like
        # EasyWork control state.
        workspace_root = easywork_workspace_root(cwd)
        target_workspace_root = easywork_workspace_root(target)
        if workspace_root is None or target_workspace_root != workspace_root:
            stop("EasyWork control files are not versioned: " + target)
    return target


def absolute_paths(candidate, cwd):
    source = str(candidate or "").strip().strip("'\"").rstrip(";,)")
    if not source or source.startswith("-") or "\x00" in source or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", source):
        return []
    if source.startswith("~"):
        source = os.path.expanduser(source)
    source = os.path.expandvars(source)
    if "$" in source or chr(96) in source or "*(" in source:
        return []
    if not glob.has_magic(source):
        target = absolute_path(source, cwd)
        return [target] if target else []
    pattern = os.path.normpath(source if os.path.isabs(source) else os.path.join(cwd, source))
    matches = glob.glob(pattern, recursive=False)
    if len(matches) > 4096:
        stop("a shell glob expands to too many versioned paths")
    return [target for match in matches for target in [absolute_path(match, cwd)] if target]


def copy_snapshot(source, destination):
    before = os.lstat(source)
    if stat.S_ISLNK(before.st_mode):
        stop("symbolic links are not versioned: " + source)
    if stat.S_ISREG(before.st_mode):
        os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
        shutil.copy2(source, destination, follow_symlinks=False)
        after = os.lstat(source)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            stop("the file changed while its pre-operation state was being captured: " + source)
        return "file"
    if stat.S_ISDIR(before.st_mode):
        for root, directories, files in os.walk(source, followlinks=False):
            for name in directories + files:
                if os.path.islink(os.path.join(root, name)):
                    stop("a directory being versioned contains a symbolic link: " + source)
        shutil.copytree(source, destination, symlinks=False, copy_function=shutil.copy2)
        return "directory"
    stop("unsupported file type: " + source)


def main():
    if len(sys.argv) != 2:
        stop("invalid hook invocation")
    hook_root = os.path.normpath(sys.argv[1])
    if not os.path.isabs(hook_root):
        stop("hook root is not absolute")
    try:
        payload = json.load(sys.stdin)
    except Exception as error:
        stop("invalid hook input: " + str(error))
    if payload.get("hook_event_name") != "PreToolUse":
        stop("hook_event_name must be PreToolUse")
    task_id = None
    explicit_task_id = str(payload.get("easywork_task_id") or "").strip()
    if explicit_task_id:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", explicit_task_id):
            stop("explicit task id is invalid")
        # OpenCode permissions are mediated by the Gateway instead of a
        # native CLI hook. Carry the already-authorized EasyWork Task id in
        # that internal invocation so a previous failed/busy native turn
        # cannot race a mutable active-task pointer and attribute the snapshot
        # to the next Web turn.
        task_id = explicit_task_id
    session_id = str(payload.get("session_id") or "")
    if task_id is None and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", session_id):
        session_task_path = os.path.join(hook_root, "session-tasks", session_id + ".json")
        try:
            with open(session_task_path, "r", encoding="utf-8") as handle:
                session_task = json.load(handle)
            if set(session_task) != {"schemaVersion", "taskId", "hookRoot"} or session_task.get("schemaVersion") != 1:
                stop("native session task binding is invalid")
            candidate_root = os.path.normpath(str(session_task.get("hookRoot") or ""))
            shared_agent_root = os.path.dirname(os.path.dirname(os.path.dirname(hook_root)))
            candidate_agent_root = os.path.dirname(os.path.dirname(os.path.dirname(candidate_root)))
            if (not os.path.isabs(candidate_root)
                    or os.path.basename(candidate_root) != "version-hooks"
                    or os.path.basename(os.path.dirname(candidate_root)) != "state"
                    or candidate_agent_root != shared_agent_root
                    or not candidate_root.startswith(shared_agent_root + os.sep)):
                stop("native session hook root is invalid")
            hook_root = candidate_root
            task_id = str(session_task.get("taskId") or "").strip()
        except FileNotFoundError:
            pass
        except Exception as error:
            stop("native session task binding is unavailable: " + str(error))
    if task_id is None:
        active_task_path = os.path.join(hook_root, "active-task")
        try:
            with open(active_task_path, "r", encoding="utf-8") as handle:
                task_id = handle.read().strip()
        except Exception as error:
            stop("active task is unavailable: " + str(error))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", task_id):
        stop("active task id is invalid")
    tool_use_id = str(payload.get("tool_use_id") or "")
    if not tool_use_id:
        stop("tool_use_id is missing")
    cwd = os.path.normpath(str(payload.get("cwd") or os.getcwd()))
    if not os.path.isabs(cwd):
        stop("tool cwd is not absolute")
    normalized = []
    for candidate in candidates(str(payload.get("tool_name") or ""), payload.get("tool_input") or {}):
        for target in absolute_paths(candidate, cwd):
            if target != "/" and target not in normalized:
                normalized.append(target)
    if not normalized:
        return
    operation_id = "op_" + hashlib.sha256((task_id + "\0" + tool_use_id).encode("utf-8")).hexdigest()[:24]
    task_root = os.path.join(hook_root, task_id)
    final_directory = os.path.join(task_root, operation_id)
    if os.path.isfile(os.path.join(final_directory, "manifest.json")):
        return
    os.makedirs(task_root, mode=0o700, exist_ok=True)
    temporary = tempfile.mkdtemp(prefix="." + operation_id + "-", dir=task_root)
    try:
        entries = []
        for target in sorted(normalized):
            if not os.path.lexists(target):
                entries.append({"path": target, "exists": False, "type": None, "payload": None})
                continue
            path_key = hashlib.sha256(target.encode("utf-8")).hexdigest()
            destination = os.path.join(temporary, "payloads", path_key, os.path.basename(target))
            kind = copy_snapshot(target, destination)
            entries.append({"path": target, "exists": True, "type": kind, "payload": os.path.relpath(destination, temporary)})
        manifest = {"schemaVersion": 4, "taskId": task_id, "operationId": operation_id, "createdAtNs": str(time.time_ns()), "entries": entries}
        manifest_path = os.path.join(temporary, "manifest.json")
        with open(manifest_path, "x", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.chmod(manifest_path, 0o600)
        try:
            os.rename(temporary, final_directory)
            temporary = None
        except FileExistsError:
            pass
    finally:
        if temporary and os.path.isdir(temporary):
            shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    main()
`;
