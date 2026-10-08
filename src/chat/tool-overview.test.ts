import assert from "node:assert/strict";
import { it } from "node:test";
import { overviewMemberId, projectToolOverview, type OverviewMember, type ToolCard } from "./tool-overview.ts";
import { toolPresentation } from "./tool-presentation.ts";
import { applyChatEntries, createChatModel, reduceChatFrame, windowOf } from "./model.ts";
import type { CustomMessage } from "./messages.ts";
const tool=(id:string,name="read",args:Record<string,unknown>={path:`${id}.ts`}):ToolCard=>({kind:"tool",id,sourceIds:[id],ownership:"call",tool:{entryId:id,call:{type:"toolCall",id,name,arguments:args},result:{role:"toolResult",timestamp:1,toolCallId:id,toolName:name,content:[],isError:false},status:"complete",mutable:false,attachments:[]}});
it("separates tools around direct and routed asks and approval decisions only",()=>{
 const rows=[tool("a"),tool("ask","ask"),tool("b"),tool("device","write",{path:"xd://task",content:'{"name":"Inspect"}'}),tool("c"),tool("decision","resolve"),tool("d")];
 const projection=projectToolOverview(rows,"conversation");
 assert.deepEqual(projection.runs.map(run=>run.members.map(overviewMemberId)),[["b","device","c"]]);
 assert.deepEqual(projection.rows.map(row=>row.kind),["tool","tool","run","tool","tool"]);
 const paired=projectToolOverview([tool("a"),tool("a2"),tool("ask","ask"),tool("b"),tool("b2"),tool("decision","resolve"),tool("c")],"conversation");
 assert.deepEqual(paired.runs.map(run=>run.members.map(overviewMemberId)),[["a","a2"],["b","b2"]]);
 assert.deepEqual(paired.rows.map(row=>row.kind),["run","tool","run","tool","tool"]);
});
let sequence=0;
const settled=(name:string,args:Record<string,unknown>,details?:Record<string,unknown>)=>{const card=tool(`${name}-${sequence++}`,name,args);if(details)card.tool.result!.details=details;return card;};
it("one group absorbs settled task, wait, IRC and generic calls with their own counts",()=>{
 const rows=[
  tool("edit","edit",{path:"a.ts"}),tool("read","read",{path:"b.ts"}),
  settled("task",{tasks:[{id:"One"},{id:"Two"}]}),
  settled("wait",{},{jobs:[{id:"One",status:"completed"},{id:"Two",status:"completed"}]}),
  settled("wait",{},{jobs:[{id:"Two",status:"completed"}]}),
  settled("write",{path:"agent://Peer",content:"hi"}),
  settled("context_notes",{}),
 ];
 const projection=projectToolOverview(rows,"conversation");
 assert.equal(projection.runs.length,1);
 assert.deepEqual(projection.rows.map(row=>row.kind),["run"]);
 assert.equal(projection.runs[0]!.summary,"Edited 1 file · Read 1 file · Spawned 2 agents · Waited for 2 jobs · Sent 1 message · 1 tool call");
 assert.deepEqual(projectToolOverview([settled("task",{task:"x"}),settled("wait",{}),settled("context_notes",{})],"conversation").runs[0]!.summary,"Spawned 1 agent · 1 wait · 1 tool call");
});
it("keeps a running task or wait as its own live row and groups it once it settles, around the same group",()=>{
 const running=(name:string)=>{const card=tool(name,name,{});card.tool.status="running";card.tool.result=undefined;return card;};
 const rows=[tool("a","bash",{command:"echo a"}),tool("b","bash",{command:"echo b"}),running("task"),tool("c","bash",{command:"echo c"}),tool("d","bash",{command:"echo d"}),running("wait")];
 const live=projectToolOverview(rows,"conversation");
 assert.deepEqual(live.rows.map(row=>row.kind),["run","tool","run","tool"]);
 assert.equal(toolPresentation(running("wait").tool).eligible,false);
 const done=[...rows.slice(0,2),tool("task","task",{}),...rows.slice(3,5),tool("wait","wait",{})];
 const after=projectToolOverview(done,"conversation",live);
 assert.deepEqual(after.rows.map(row=>row.kind),["run"]);
 assert.equal(after.runs[0]!.id,live.runs[0]!.id,"the group that came first keeps its key when the live row settles into it");
});
it("a failed task or wait joins the group and shows in its failure count",()=>{
 const failed=tool("task","task",{task:"x"});failed.tool.status="error";failed.tool.result!.isError=true;
 const run=projectToolOverview([tool("a"),failed,tool("w","wait",{})],"conversation").runs[0]!;
 assert.equal(run.failureCount,1);
 assert.match(run.summary,/Attempted to spawn 1 agent/);
 assert.match(run.summary,/1 failed/);
});
it("retains run state on leading-member removal and allocates collision-free split descendants",()=>{
 const first=projectToolOverview([tool("a"),tool("b"),tool("c"),tool("d")],"conversation");
 const removed=projectToolOverview([tool("b"),tool("c"),tool("d")],"conversation",first);
 assert.equal(removed.runs[0]!.id,first.runs[0]!.id);
 const split=projectToolOverview([tool("b"),tool("c"),tool("ask","ask"),tool("d"),tool("e")],"conversation",removed);
 assert.equal(split.runs[0]!.id,first.runs[0]!.id);
 assert.notEqual(split.runs[1]!.id,first.runs[0]!.id);
 const merged=projectToolOverview([tool("b"),tool("c"),tool("d"),tool("e")],"conversation",split);
 assert.equal(merged.runs[0]!.id,first.runs[0]!.id);
 assert.equal(merged.redirects.get(split.runs[1]!.id),merged.runs[0]!.id);
});
it("never transfers an orphan's disclosure into its earlier owner's run",()=>{
 const orphan={...tool("result"),ownership:"orphan" as const,tool:{...tool("call").tool,entryId:"call"}};
 const first=projectToolOverview([orphan,tool("x")],"conversation");
 const next=projectToolOverview([tool("call"),tool("y")],"conversation",first);
 assert.notEqual(next.runs[0]!.id,first.runs[0]!.id);
});
it("shows a lone call as the plain row and groups only from two calls",()=>{
 const only=tool("only","bash",{command:"echo hi"});
 const single=projectToolOverview([only],"conversation");
 assert.deepEqual(single.runs,[]);
 assert.equal(single.rows.length,1);
 assert.equal(single.rows[0],only);
 const pair=projectToolOverview([only,tool("second","bash",{command:"echo two"})],"conversation",single);
 assert.equal(pair.runs.length,1);
 assert.deepEqual(pair.rows,[pair.runs[0]]);
 assert.match(pair.runs[0]!.summary,/Ran 2 commands/);
 const shrunk=projectToolOverview([only],"conversation",pair);
 assert.deepEqual(shrunk.runs,[]);
 assert.equal(shrunk.rows[0],only);
});
it("keeps the run key and source aliases when a live singleton grows into a group and shrinks back",()=>{
 const first=tool("a","bash",{command:"echo a"});
 const single=projectToolOverview([first],"conversation");
 const grown=projectToolOverview([first,tool("b","bash",{command:"echo b"})],"conversation",single);
 assert.equal(grown.runs[0]!.id,single.latent[0]!.id);
 assert.deepEqual(grown.runs[0]!.sourceIds,["a","b"]);
 assert.equal(grown.redirects.size,0);
 const shrunk=projectToolOverview([first],"conversation",grown);
 assert.equal(shrunk.latent[0]!.id,grown.runs[0]!.id);
 const regrown=projectToolOverview([first,tool("c","bash",{command:"echo c"})],"conversation",shrunk);
 assert.equal(regrown.runs[0]!.id,grown.runs[0]!.id);
});
it("keeps failure, running and live edit state on a lone call row",()=>{
 const failed=tool("failed","bash",{command:"false"});failed.tool.result!.details={exitCode:1};
 assert.equal(toolPresentation(failed.tool).failed,true);
 const running=tool("running","bash",{command:"sleep 5"});running.tool.status="running";running.tool.result=undefined;
 const live=tool("edit","edit",{path:"a.ts"});live.tool.status="running";
 live.tool.active={toolCallId:"edit",toolName:"edit",args:{},startedAt:1,streamUpdate:{editDiffPreview:{diff:"-old\n+new"}}};
 for(const card of [failed,running,live])assert.equal(projectToolOverview([card],"conversation").rows[0],card);
 assert.equal(toolPresentation(live.tool).liveDetail,true);
});
it("counts proven case-sensitive distinct files without treating agent writes as file edits",()=>{
 const rows=[tool("one","read",{path:"/repo/A.ts"}),tool("two","read",{path:"A.ts"}),tool("three","read",{path:"a.ts"}),tool("irc","write",{path:"agent://Peer",content:"hello"})];
 const run=projectToolOverview(rows,"conversation",undefined,"/repo").runs[0]!;
 assert.equal(run.summary,"Read 2 files · Sent 1 message");
});
it("counts different native selector views as one file while retaining every selected call target",()=>{
 const selectors=["1-1","2-2","L5..L16,L960-L973","50+10","50-","50..","-60","raw","conflicts","img","1-50:raw","raw:1-50","-60:raw","raw:-60"];
 const cards=selectors.map((selector,index)=>tool(`view-${index}`,"read",{path:`C:\\repo\\A.ts:${selector}`}));
 const run=projectToolOverview(cards,"conversation",undefined,"C:/repo").runs[0]!;
 assert.equal(run.summary,"Read 1 file");
 assert.deepEqual(run.members.map(overviewMemberId),cards.map(card=>card.tool.call.id));
 for(let index=0;index<cards.length;index++)assert.equal(toolPresentation(cards[index]!.tool,"C:/repo").target,`A.ts:${selectors[index]}`);
});
it("honors native resolved literal targets and does not peel unknown or incomplete colon suffixes",()=>{
 const literal=tool("literal","read",{path:"/repo/A.ts:raw"});
 literal.tool.result!.details={resolvedPath:"/repo/A.ts:raw"};
 const run=projectToolOverview([literal,tool("ordinary","read",{path:"A.ts:1-2"})],"conversation",undefined,"/repo").runs[0]!;
 assert.equal(run.summary,"Read 2 files");
 for(const path of ["notes:topic","A.ts:20+","A.ts:L","C:50"]){
  assert.deepEqual(toolPresentation(tool(path,"read",{path}).tool).paths,[path]);
 }
});
it("exposes actual live edits, not empty preparing rows, then removes automatic expansion on completion",()=>{
 const live=tool("edit","edit",{path:"a.ts"});live.tool.status="running";
 assert.equal(toolPresentation(live.tool).liveDetail,false);
 live.tool.active={toolCallId:"edit",toolName:"edit",args:{},startedAt:1,streamUpdate:{editDiffPreview:{diff:"-old\n+new"}}};
 assert.equal(toolPresentation(live.tool).liveDetail,true);
 assert.deepEqual(projectToolOverview([live,tool("extra")],"conversation").runs[0]!.liveEditIds,["edit"]);
 live.tool.status="error";
 const run=projectToolOverview([live,tool("extra")],"conversation").runs[0]!;
 assert.deepEqual(run.liveEditIds,[]);assert.equal(run.failureCount,1);assert.match(run.summary,/failed/);
});
it("uses authoritative route precedence and device arguments for excluded questions",()=>{
 const routed=tool("write","write",{path:"xd://read",content:'{"path":"file.ts"}'});
 routed.tool.result={role:"toolResult",timestamp:1,toolCallId:"write",toolName:"write",content:[],isError:false,details:{message:{to:"Main"},xdev:{tool:"ask"}}};
 assert.equal(toolPresentation(routed.tool).route.kind,"agent");
 assert.equal(toolPresentation(routed.tool).category,"message");
 routed.tool.result=undefined;routed.tool.call.arguments={path:"xd://ask",content:'{"question":"Ship?"}'};
 assert.equal(toolPresentation(routed.tool).eligible,false);
});
it("native nonzero exits and per-file failures count as failed, while skipped and unavailable results never claim completed work",()=>{
 const command=tool("command","bash",{command:"false"});
 command.tool.result!.details={exitCode:2};
 const edit=tool("edit","edit",{path:"a.ts"});
 edit.tool.result!.details={perFileResults:[{path:"a.ts",displayErrorText:"Permission denied"}]};
 const skipped=tool("skipped");skipped.tool.status="skipped";
 const unavailable=tool("unavailable");unavailable.tool.result=undefined;
 for(const card of [command,edit,skipped,unavailable])assert.equal(toolPresentation(card.tool).completed,false);
 assert.equal(toolPresentation(command.tool).failed,true);
 assert.equal(toolPresentation(edit.tool).failed,true);
 assert.equal(toolPresentation(skipped.tool).failed,false);
 const run=projectToolOverview([command,edit,skipped,unavailable],"conversation").runs[0]!;
 assert.equal(run.failureCount,2);
 assert.match(run.summary,/Attempted/);
 assert.match(run.summary,/1 skipped/);
 assert.match(run.summary,/1 result unavailable/);
 assert.doesNotMatch(run.summary,/Edited|Completed|Read \d|Ran \d/);
});

it("native IRC messages join each other and tools, retaining sources, ordering and run identity", () => {
 const irc = (id: string, customType: string): OverviewMember => ({
  kind: "entry", id, sourceIds: [id], entry: { type: "custom_message", id, parentId: null, timestamp: "2026-10-08T00:00:00Z", customType, content: "Message body", display: true },
 });
 const messages = ["irc:relay", "irc:incoming", "irc:autoreply", "irc:workpool"].map((kind, index) => irc(`message-${index}`, kind));
 const first = projectToolOverview([messages[0]!], "conversation");
 assert.equal(first.rows[0], messages[0], "one message remains an individual row");
 const mixed = [messages[0]!, tool("read"), ...messages.slice(1), settled("write", { path: "agent://Peer", content: "Hello" })];
 const live = projectToolOverview(mixed, "conversation", first);
 const resumed = projectToolOverview(mixed, "conversation");
 const run = live.runs[0]!;
 assert.equal(run.id, first.latent[0]!.id, "message singleton grows without replacing its group identity");
 assert.deepEqual(run.members, mixed);
 assert.deepEqual(run.sourceIds, mixed.flatMap(card => card.sourceIds));
 assert.equal(run.summary, "Read 1 file · 5 messages");
 assert.equal(run.summary, resumed.runs[0]?.summary);
 const messagesOnly = projectToolOverview(messages, "conversation").runs[0]!;
 assert.equal(messagesOnly.summary, "4 messages");
 assert.equal(messagesOnly.runningCount, 0, "received messages never claim active work");
 const boundary = irc("ordinary-notice", "native:notice");
 assert.deepEqual(projectToolOverview([messages[0]!, boundary, messages[1]!], "conversation").rows.map(card => card.id), ["message-0", "ordinary-notice", "message-1"]);
});

it("live native IRC observations and saved incoming rows produce the same counted overview", () => {
 const message = (customType: string, timestamp: number): CustomMessage => ({ role: "custom", customType, display: true, content: "Report", timestamp, details: { from: "Reader", to: "Coordinator", message: "Report", body: "Report" } });
 const relay = message("irc:relay", 1), incoming = message("irc:incoming", 2);
 let model = reduceChatFrame(createChatModel(), { type: "irc_message", message: relay });
 model = reduceChatFrame(model, { type: "irc_message", message: incoming });
 const live = projectToolOverview(windowOf(model, 100, null).rows, "conversation").runs[0]!;
 assert.equal(live.summary, "2 messages");
 model = applyChatEntries(model, [{ type: "message", id: "saved-incoming", parentId: null, timestamp: new Date(2).toISOString(), message: incoming }], "saved-incoming");
 const reconciled = projectToolOverview(windowOf(model, 100, null).rows, "conversation").runs[0]!;
 assert.equal(reconciled.summary, live.summary);
 assert.equal(reconciled.members.length, 2, "saving incoming replaces its observation rather than counting it twice");
});
