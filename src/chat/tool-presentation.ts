/** Shared native route decisions and density metadata. Never creates render bodies. */
import { isRecord } from "../guards.ts";
import type { ProjectedTool } from "./transcript.ts";
export interface ToolRoute { kind: "native" | "agent" | "process" | "config" | "device" | "help"; name: string; args: Record<string, unknown>; details: Record<string, unknown> }
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
export function resolveToolRoute(name: string, args: Record<string, unknown>, details: Record<string, unknown>): ToolRoute {
 if (name !== "write") return {kind:"native",name,args,details};
 const path = text(args.path ?? args.file_path);
 if (details.message !== undefined) return {kind:"agent",name,args,details};
 if (details.proc !== undefined) return {kind:"process",name,args,details};
 if (details.cfg !== undefined) return {kind:"config",name,args,details};
 if (/^agent:\/\//i.test(path)) return {kind:"agent",name,args,details};
 if (/^proc:\/\//i.test(path)) return {kind:"process",name,args,details};
 if (/^cfg:\/\//i.test(path)) return {kind:"config",name,args,details};
 const dispatch = record(details.xdev);
 if (dispatch.tool !== undefined || /^xd:\/\//i.test(path)) {
  const innerName = text(dispatch.tool) || path.replace(/^xd:\/\//i, "").split(/[/?#:]/,1)[0] || "xd";
  if (dispatch.mode === "help") return {kind:"help",name:innerName,args:{},details:{}};
  let innerArgs = record(dispatch.args);
  if (dispatch.args === undefined && typeof args.content === "string") {
   try { innerArgs = record(JSON.parse(args.content)); } catch { /* Non-JSON device input has no structured arguments. */ }
  }
  if ((innerName === "resolve" || innerName === "reject") && !innerArgs.reason && typeof args.content === "string") innerArgs = {...innerArgs,reason:args.content};
  return {kind:"device",name:innerName,args:innerArgs,details:record(dispatch.inner)};
 }
 return {kind:"native",name,args,details};
}
export type ToolCategory = "edit" | "command" | "read" | "search" | "agent" | "wait" | "message" | "other";
/** `agents` is how many subagents a task call spawns; `jobs` are the distinct jobs a settled wait reports (both empty for other tools). */
export interface ToolPresentation { route: ToolRoute; title: string; target: string; category: ToolCategory; eligible: boolean; paths: readonly string[]; agents: number; jobs: readonly string[]; liveDetail: boolean; failed: boolean; completed: boolean; warnings: number }
const titles: Readonly<Record<string,string>> = {ask:"Ask",task:"Task",read:"Read",edit:"Edit",apply_patch:"Edit",ast_edit:"AST edit",write:"Write",bash:"Bash",python:"Python",eval:"Python",grep:"Grep",ast_grep:"AST grep",glob:"Glob",find:"Find",web_search:"Web search",todo:"TODO",wait:"Wait",debug:"Debug",lsp:"LSP",goal:"Goal",resolve:"Resolve",reject:"Reject",github:"GitHub",think:"Think",retain:"Retain",recall:"Recall",reflect:"Reflect"};
export function normalizeToolPath(path: string, cwd?: string): string {
 const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
 const root = cwd?.replaceAll("\\", "/").replace(/\/$/, "");
 return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length+1) : normalized;
}
// Ordinary file-view selectors verified in OMP's tui/tools/{read,line-ranges}.ts.
// They affect the displayed read, not the file count; native resolved paths take precedence.
const READ_RANGE_CHUNK = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const READ_RANGES = new RegExp(`^(?:${READ_RANGE_CHUNK}(?:,${READ_RANGE_CHUNK})*|-\\d+)$`, "i");
const READ_MODES = /^(?:raw|conflicts|img)$/i, READ_RAW = /^raw$/i;
function readFilePath(path: string): string {
 const colon = path.lastIndexOf(":");
 if (colon <= 0 || colon === 1 && /^[a-z]:/i.test(path)) return path;
 const selector = path.slice(colon + 1);
 if (!READ_RANGES.test(selector) && !READ_MODES.test(selector)) return path;
 const base = path.slice(0, colon), inner = base.lastIndexOf(":");
 if (inner > 0) {
  const preceding = base.slice(inner + 1);
  if (READ_RAW.test(selector) && READ_RANGES.test(preceding) || READ_RAW.test(preceding) && READ_RANGES.test(selector)) return base.slice(0, inner);
 }
 return base;
}
export function toolPresentation(tool: ProjectedTool, cwd?: string): ToolPresentation {
 const partial = record(tool.active?.partialResult);
 const route = resolveToolRoute(tool.call.name,record(tool.active?.args ?? tool.call.arguments),record(tool.result?.details ?? partial.details));
 const {name,args,details} = route;
 const native = route.kind === "native" || route.kind === "device";
 const named = (value: string): boolean => native && name === value;
 const category: ToolCategory = route.kind === "agent" ? "message" : named("task") ? "agent" : named("wait") ? "wait" : native && ["edit","apply_patch","ast_edit","write"].includes(name) && !(route.kind === "device" && name === "write") ? "edit" : native && ["bash","python","eval"].includes(name) ? "command" : native && name === "read" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text(args.path)) ? "read" : native && ["grep","ast_grep","find","glob","web_search"].includes(name) ? "search" : "other";
 const path = text(args.path ?? args.file_path ?? args.file);
 const fileRows = [details.perFileResults, details.files, record(tool.active?.streamUpdate).files, record(tool.active?.streamUpdate).perFileDiffPreview].flatMap(value => Array.isArray(value) ? value.filter(isRecord) : []);
 const files = fileRows.flatMap(file => { const value = text(file.path ?? file.file_path); return value ? [value] : []; });
 const filePath = category === "read" ? text(details.resolvedPath) || readFilePath(path) : path;
 const paths = category === "edit" || category === "read" ? [...new Set((files.length ? files : filePath ? [filePath] : []).map(value => normalizeToolPath(value,cwd)))] : [];
 const stream = record(tool.active?.streamUpdate);
 const preview = (value: unknown): boolean => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : false;
 const liveDetail = category === "edit" && (tool.status === "queued" || tool.status === "running") && [args.content,args.newText,args.patch,args.input,args.previewDiff,args.diff,details.diff,record(stream.editDiffPreview).diff,stream.editStreamingFallback,...(Array.isArray(stream.files) ? stream.files.filter(isRecord).map(file => file.diff) : []),...(Array.isArray(stream.perFileDiffPreview) ? stream.perFileDiffPreview.filter(isRecord).map(file => file.diff) : []),partial.editDiffPreview,partial.content].some(preview);
 const warnings = tool.attachments.reduce((count,message) => count + (isRecord(message.details) && Array.isArray(message.details.files) ? message.details.files.filter(isRecord).reduce((sum,file) => sum + (Array.isArray(file.messages) ? file.messages.length : 0),0) : 0),0);
 const pending = tool.status === "queued" || tool.status === "running";
 const taskRows = Array.isArray(args.tasks) ? args.tasks.filter(isRecord).length : 0;
 const agents = category === "agent" ? Math.max(1, taskRows) : 0;
 const jobRows = Array.isArray(details.jobs) ? details.jobs.filter(isRecord) : isRecord(details.job) ? [details.job] : [];
 // A settled wait reports its finished jobs; still-running rows are the next poll's business unless nothing else remains.
 const settledJobs = jobRows.some(job => job.status !== "running") ? jobRows.filter(job => job.status !== "running") : jobRows;
 const jobs = category === "wait" ? [...new Set(settledJobs.map(job => text(job.name) || text(job.id)).filter(Boolean))] : [];
 // A running task or wait keeps its own live row and joins the adjacent group once it settles.
 const excluded = ["ask","resolve","reject","approve","approval","question","confirm"].includes(name) || (name === "task" || name === "wait") && pending || name.startsWith("vibe_") || details.requiresApproval === true || details.pendingApproval === true;
 const target = route.kind === "agent" ? `→ ${text(record(details.message).to) || path.replace(/^agent:\/\//i,"")}` : route.kind === "process" || route.kind === "config" ? path : text(args.command ?? args.code ?? args.query ?? args.pattern ?? args.objective) || (category === "read" && path ? normalizeToolPath(path,cwd) : paths.join(", ")) || path;
 const failed = tool.status !== "skipped" && (tool.status === "error" || tool.result?.isError === true || details.isError === true || Boolean(details.error) ||
  category === "command" && (typeof details.exitCode === "number" && details.exitCode !== 0 || Array.isArray(details.cells) && details.cells.filter(isRecord).some(cell => cell.status === "error" || typeof cell.exitCode === "number" && cell.exitCode !== 0)) ||
  category === "edit" && fileRows.some(file => file.isError === true || Boolean(text(file.error) || text(file.errorText) || text(file.displayErrorText))));
 return {route,title:route.kind === "agent" ? "IRC" : route.kind === "process" ? "Process" : route.kind === "config" ? "Config" : route.kind === "help" ? name : titles[name] ?? name,target,category,eligible:!excluded,paths,agents,jobs,liveDetail,failed,completed:tool.status === "complete" && tool.result !== undefined && !failed,warnings};
}
