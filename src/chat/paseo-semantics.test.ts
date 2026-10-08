import assert from "node:assert/strict";
import { it } from "node:test";
import { advisorNotes, parseChatMessage, userSkill, type CustomMessage } from "./messages.ts";
import { createChatModel, reduceChatFrame } from "./model.ts";
const custom = (details: unknown): CustomMessage => ({ role: "custom", customType: "skill-prompt", display: true, attribution: "user", content: "Expanded skill", timestamp: 1, details });
it("attributes only native visible user skills and distinguishes reconstruction from exact submitted prompts", () => {
 assert.deepEqual(userSkill(custom({name:"review",args:"file.ts"})), { name:"review",args:"file.ts",prompt:"Invoked /skill:review · file.ts",reconstructed:true });
 assert.equal(userSkill(custom({name:"review",prompt:"Please /skill:review file.ts"}))?.reconstructed,false);
 assert.equal(userSkill({...custom({name:"review"}),attribution:"agent"}),null);
 assert.equal(userSkill({...custom({name:"review"}),display:false}),null);
 assert.equal(userSkill(custom({name:"review",args:4})),null);
});
it("counts nonempty advisor notes while preserving unknown severity and all blockers", () => {
 const notes = advisorNotes({...custom({notes:[{note:"  ",severity:"blocker"},{note:"One",severity:"unexpected"},{note:"Fix",severity:"blocker",advisor:"Security"}]}),customType:"advisor"});
 assert.deepEqual(notes,[{note:"One",severity:"unknown"},{note:"Fix",severity:"blocker",advisor:"Security"}]);
});
it("rejects misleading timing rather than replacing missing duration with zero", () => {
 const parsed = parseChatMessage({role:"assistant",content:[],model:"m",stopReason:"stop",timestamp:100,duration:-1,completedAt:99,ttft:Infinity});
 assert.ok(parsed?.role === "assistant");
 assert.equal(parsed.duration,undefined); assert.equal(parsed.completedAt,undefined); assert.equal(parsed.ttft,undefined);
});
it("anchors retry completion at its original attempt and records distinct repeated attempts and goals", () => {
 let model = reduceChatFrame(createChatModel(),{type:"auto_retry_start",attempt:1,maxAttempts:3,delayMs:2000,errorMessage:"Reason"},{now:1});
 const anchor = model.ephemeral[0]!;
 model = reduceChatFrame(model,{type:"notice",level:"info",message:"Later"},{now:2});
 model = reduceChatFrame(model,{type:"auto_retry_end",attempt:1,success:true},{now:3});
 assert.equal(model.ephemeral[0]!.id,anchor.id); assert.equal(model.ephemeral[0]!.seq,anchor.seq);
 const payload = model.ephemeral[0]!.payload;
 assert.ok(payload && typeof payload === "object" && "status" in payload);
 assert.equal(payload.status,"recovered");
 model = reduceChatFrame(model,{type:"auto_retry_start",attempt:1,maxAttempts:3,delayMs:1000,errorMessage:"Again"},{now:4});
 assert.notEqual(model.ephemeral[2]!.id,anchor.id);
 model = reduceChatFrame(model,{type:"goal_updated",goal:{objective:"Ship",status:"active"}},{now:5});
 assert.equal(model.ephemeral.at(-1)?.kind,"goal_updated");
});
