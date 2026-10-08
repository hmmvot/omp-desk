/** Presentation-only runs over admitted canonical cards. Storage and results remain individual. */
import type { TranscriptCard } from "./transcript.ts";
import { entryMessage } from "./messages.ts";
import { toolPresentation, type ToolCategory } from "./tool-presentation.ts";
export type ToolCard = Extract<TranscriptCard,{kind:"tool"}>;
export type OverviewMember = ToolCard | Extract<TranscriptCard, { kind: "entry" }>;
export interface ToolRun { kind: "run"; id: string; sourceIds: readonly string[]; memberKeys: readonly string[]; members: readonly OverviewMember[]; runningCount: number; failureCount: number; warningCount: number; summary: string; liveEditIds: readonly string[] }
export type DensityCard = TranscriptCard | ToolRun;
/** Identity of a one-call run: shown as the plain tool row, kept so the group it may grow into retains its key. */
export interface LatentRun { id: string; memberKeys: readonly string[] }
export interface OverviewProjection { namespace: string; nextAllocation: number; rows: readonly DensityCard[]; runs: readonly ToolRun[]; latent: readonly LatentRun[]; redirects: ReadonlyMap<string,string> }
const IRC_TYPES: Record<string, true> = { "irc:relay": true, "irc:incoming": true, "irc:autoreply": true, "irc:workpool": true };
export function isOverviewMessage(card: TranscriptCard): card is Extract<TranscriptCard, { kind: "entry" }> {
 if (card.kind !== "entry") return false;
 const message = entryMessage(card.entry);
 return (message?.role === "custom" || message?.role === "hookMessage") && message.display && Object.hasOwn(IRC_TYPES, message.customType);
}
export function overviewMemberId(card: OverviewMember): string { return card.kind === "tool" ? card.tool.call.id : `irc:${card.id}`; }
function memberKey(card: OverviewMember): string { return card.kind === "entry" ? overviewMemberId(card) : card.ownership === "orphan" ? `orphan:${card.id}:${card.tool.call.id}` : `call:${card.tool.call.id}`; }
function summarize(members: readonly OverviewMember[], cwd?: string): Omit<ToolRun,"kind"|"id"|"sourceIds"|"memberKeys"|"members"> {
 const buckets = new Map<ToolCategory,{calls:number;paths:Set<string>;unknown:number;incomplete:number;running:number;agents:number;jobs:Set<string>;jobless:number}>();
 let runningCount=0, failureCount=0, warningCount=0, skippedCount=0, unavailableCount=0;
 const liveEditIds: string[]=[];
 let messageCount = 0;
 for (const card of members) {
  if (card.kind === "entry") { messageCount++; continue; }
  const metadata=toolPresentation(card.tool,cwd);
  const bucket=buckets.get(metadata.category) ?? {calls:0,paths:new Set<string>(),unknown:0,incomplete:0,running:0,agents:0,jobs:new Set<string>(),jobless:0};
  bucket.calls++; bucket.agents+=metadata.agents; for (const job of metadata.jobs) bucket.jobs.add(job); if (metadata.category === "wait" && metadata.jobs.length === 0) bucket.jobless++;
  if (metadata.paths.length) for (const path of metadata.paths) bucket.paths.add(path); else bucket.unknown++;
  buckets.set(metadata.category,bucket);
  if (card.tool.status === "queued" || card.tool.status === "running") { runningCount++; bucket.running++; }
  if (!metadata.completed) bucket.incomplete++;
  if (card.tool.status === "skipped") skippedCount++;
  if (card.tool.status === "complete" && card.tool.result === undefined) unavailableCount++;
  if (metadata.failed) failureCount++;
  warningCount+=metadata.warnings;
  if (metadata.liveDetail) liveEditIds.push(card.tool.call.id);
 }
 if (messageCount) {
  const bucket = buckets.get("message") ?? {calls:0,paths:new Set<string>(),unknown:0,incomplete:0,running:0,agents:0,jobs:new Set<string>(),jobless:0};
  bucket.calls += messageCount;
  buckets.set("message", bucket);
 }
 const parts:string[]=[];
 const plural=(count:number,noun:string):string=>`${count} ${noun}${count===1?"":noun==="search"?"es":"s"}`;
 for (const category of ["edit","command","read","search","agent","wait","message","other"] as const) {
  const bucket=buckets.get(category); if (!bucket) continue;
  if (category === "edit" || category === "read") {
   const verb=category === "edit" ? bucket.running ? "Editing" : bucket.incomplete ? "Attempted edits to" : "Edited" : bucket.running ? "Reading" : bucket.incomplete ? "Attempted reads of" : "Read";
   if (bucket.paths.size) parts.push(`${verb} ${plural(bucket.paths.size,"file")}`);
   if (bucket.unknown) parts.push(`${bucket.running ? category === "edit" ? "Preparing" : "Reading" : bucket.incomplete ? "Attempted" : "Completed"} ${plural(bucket.unknown,category)}`);
  } else if (category === "command") parts.push(`${bucket.running?"Running":bucket.incomplete?"Attempted":"Ran"} ${plural(bucket.calls,"command")}`);
  else if (category === "agent") parts.push(`${bucket.incomplete?"Attempted to spawn":"Spawned"} ${plural(bucket.agents,"agent")}`);
  else if (category === "wait") {
   if (bucket.incomplete) parts.push(`Attempted ${plural(bucket.calls,"wait")}`);
   else { if (bucket.jobs.size) parts.push(`Waited for ${plural(bucket.jobs.size,"job")}`); if (bucket.jobless) parts.push(plural(bucket.jobless,"wait")); }
  } else if (category === "message") parts.push(messageCount ? plural(bucket.calls,"message") : `${bucket.incomplete?"Attempted to send":"Sent"} ${plural(bucket.calls,"message")}`);
  else parts.push(`${bucket.incomplete && !bucket.running ? "Attempted " : ""}${plural(bucket.calls,category === "search" ? "search" : "tool call")}`);
 }
 if (failureCount) parts.push(`${failureCount} failed`);
 if (skippedCount) parts.push(`${skippedCount} skipped`);
 if (unavailableCount) parts.push(`${unavailableCount} result${unavailableCount === 1 ? "" : "s"} unavailable`);
 if (warningCount) parts.push(plural(warningCount,"warning"));
 return {runningCount,failureCount,warningCount,summary:parts.join(" · "),liveEditIds};
}
export function projectToolOverview(cards: readonly TranscriptCard[], namespace: string, previous?: OverviewProjection, cwd?: string): OverviewProjection {
 const old=previous?.namespace===namespace ? previous : undefined;
 const prior:readonly LatentRun[]=old ? [...old.runs,...old.latent] : [];
 let nextAllocation=old?.nextAllocation ?? 1;
 const claimed=new Set<string>();
 const redirects=new Map(old?.redirects);
 const rows:DensityCard[]=[],runs:ToolRun[]=[],latent:LatentRun[]=[];
 let pending:OverviewMember[]=[];
 const flush=():void=>{
  if (!pending.length) return;
  const memberKeys=pending.map(memberKey), keys=new Set(memberKeys);
  const overlaps=prior.filter(run=>run.memberKeys.some(key=>keys.has(key)));
  const retained=overlaps.find(run=>!claimed.has(run.id));
  const id=retained?.id ?? `run:${namespace}:${overviewMemberId(pending[0]!)}:${nextAllocation++}`;
  for (const run of overlaps) {
   if (claimed.has(run.id)) continue;
   claimed.add(run.id); if (run.id!==id) redirects.set(run.id,id);
  }
  if (pending.length === 1) {
   // A group exists only for two or more members; a lone tool or message stays individual.
   rows.push(pending[0]!);latent.push({id,memberKeys});pending=[];return;
  }
  const run:ToolRun={kind:"run",id,sourceIds:[...new Set(pending.flatMap(card=>card.sourceIds))],memberKeys,members:pending,...summarize(pending,cwd)};
  rows.push(run);runs.push(run);pending=[];
 };
 for (const card of cards) {
  if (isOverviewMessage(card) || card.kind === "tool" && toolPresentation(card.tool,cwd).eligible) pending.push(card);
  else {flush();rows.push(card);}
 }
 flush();
 return {namespace,nextAllocation,rows,runs,latent,redirects};
}
