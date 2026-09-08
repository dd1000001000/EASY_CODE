import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition } from "../core/types.js";
import type { DownloadBroker } from "../downloads/broker.js";
import { toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";
import { networkCommandApprovalPrefix } from "../command/approval.js";
import { requestNetworkApproval } from "../command/network-approval.js";
import { sha256 } from "../utils/hash.js";

export class FetchArtifactTool implements AgentTool {
  readonly name="fetch_artifact" as const;
  readonly mutating=true;
  readonly inputSchema=z.object({action:z.enum(["list","fetch"]),artifactId:z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/u).optional(),offset:z.number().int().min(0).max(4096).optional()}).strict();
  readonly definition:ToolDefinition={type:"function",function:{name:this.name,strict:true,...documentToolSchema(this.name,{
    type:"object",additionalProperties:false,required:["action"],properties:{action:{type:"string",enum:["list","fetch"]},artifactId:{type:"string"},offset:{type:"integer",minimum:0,maximum:4096}}
  })}};
  constructor(private readonly broker:DownloadBroker){}
  async execute(input:unknown,context:ToolContext){
    try {
      if (!this.broker.matchesWorkspace(context.workspaceRoot)) throw new Error("Artifact broker workspace mismatch");
      if(context.mode==="plan"||context.agentRole==="subagent") throw new Error("Artifact downloads are main-agent Code capabilities only");
      const parsed=this.inputSchema.parse(input);
      if(parsed.action==="list") return toolSuccess("Approved artifacts (no network request)",this.broker.list(parsed.offset));
      if(!parsed.artifactId) throw new Error("artifactId is required; URLs cannot be supplied by the model");
      const approved = await requestNetworkApproval(context, {
        id: `fetch_artifact:${parsed.artifactId}`, title: `Download approved artifact ${parsed.artifactId}`,
        description: "Download an immutable catalog artifact into the workspace; verify integrity and do not execute it.",
        risk: "install", network: { effect: "download" },
        commandPrefix: networkCommandApprovalPrefix("tool:fetch_artifact", [], sha256("fetch_artifact:catalog-only:v1")),
      });
      if (!approved) throw new Error("Artifact download approval was not granted");
      return toolSuccess("Verified artifact downloaded; install or inspect offline, never execute during download",await this.broker.fetch(parsed.artifactId,context.signal));
    }catch(error){return toolFailure(error,"Artifact request rejected or failed");}
  }
}
