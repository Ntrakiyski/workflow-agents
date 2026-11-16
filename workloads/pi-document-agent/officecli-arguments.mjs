import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function assignedDocument(env) {
  const root = env.PI_REQUEST_ROOT;
  const doc = env.PI_DOCX_PATH;
  if (!root || !doc || !isAbsolute(root) || !isAbsolute(doc)) throw new Error("Assigned document required");
  const expected = resolve(root, "outputs", "document.docx");
  if (doc !== expected || relative(realpathSync(root), realpathSync(doc)) !== "outputs/document.docx") {
    throw new Error("Document must be the controller-assigned working copy");
  }
  return doc;
}

export function buildArguments(doc, operation, params) {
  const path = params.path ?? "/";
  if (!path.startsWith("/") || path.includes("\0") || path.length > 512) throw new Error("Invalid document node path");
  switch (operation) {
    case "help": return ["help", "docx", "paragraph"];
    case "read": {
      const args = ["view", doc, "text", "--max-lines", "200"];
      if (params.start !== undefined) args.push("--start", String(params.start));
      if (params.end !== undefined) args.push("--end", String(params.end));
      return args;
    }
    case "outline": return ["view", doc, "outline"];
    case "issues": return ["view", doc, "issues", "--json"];
    case "validate": return ["validate", doc, "--json"];
    case "get": return ["get", doc, path, "--depth", "3", "--json"];
    case "replace_text":
      if (!params.find || params.text === undefined) throw new Error("Find and replacement text required");
      return ["set", doc, path, "--find", params.find, "--replace", params.text];
    case "set_text":
      if (params.text === undefined || path === "/") throw new Error("Node path and text required");
      return ["set", doc, path, "--prop", "text=" + params.text];
    case "add_paragraph": {
      if (params.text === undefined || (params.after && params.before)) throw new Error("Text and one insertion anchor at most required");
      const args = ["add", doc, params.path ?? "/body", "--type", "paragraph", "--prop", "text=" + params.text];
      args.push("--prop", "style=" + (params.style ?? "Normal"));
      if (params.after) args.push("--after", params.after);
      if (params.before) args.push("--before", params.before);
      return args;
    }
    default: throw new Error("Unsupported document operation");
  }
}
