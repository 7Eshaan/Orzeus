import { z } from "zod";
import { TaskDAG } from "./dag.js";
import { ContextPacketBody } from "./packet.js";

/** What the planner returns: the DAG plus one packet body per node (hashes are added on ingest). */
export const PlannerOutput = z.object({
  dag: TaskDAG,
  packets: z.array(ContextPacketBody).min(1),
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;
