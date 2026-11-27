import { test as base } from '@playwright/test';
import { Client } from 'pg';

// The performance tests run against shop_perf, a copy of the shop schema with
// hundreds of thousands of rows (db/perf/volume.sql), created by
// global-setup.ts. They only read, except inside rolled-back transactions.
export const test = base.extend<object, { perf: Client }>({
  perf: [
    async ({}, use) => {
      const url = process.env.PERF_DB_URL;
      if (!url) throw new Error('PERF_DB_URL is not set: global-setup.ts creates shop_perf for the perf project');
      const perf = new Client({ connectionString: url });
      await perf.connect();
      await use(perf);
      await perf.end();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';

// One node of an EXPLAIN (FORMAT JSON) plan, with the fields the tests read.
export type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Heap Fetches'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
};

export type Explained = {
  root: PlanNode;
  nodes: PlanNode[]; // every node, depth first
  nodeTypes: string[];
  indexes: string[];
  relations: string[];
  // Pages (8 kB blocks) the query touched, from cache or disk. Unlike time,
  // this does not depend on the machine: the same plan over the same data
  // reads the same pages.
  buffers: number;
};

// Runs the query under EXPLAIN (ANALYZE, BUFFERS) and flattens the plan.
export async function explain(db: Client, sql: string, params: unknown[] = []): Promise<Explained> {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const root: PlanNode = rows[0]['QUERY PLAN'][0].Plan;
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    nodes.push(node);
    node.Plans?.forEach(walk);
  };
  walk(root);
  return {
    root,
    nodes,
    nodeTypes: nodes.map((n) => n['Node Type']),
    indexes: nodes.flatMap((n) => (n['Index Name'] ? [n['Index Name']] : [])),
    relations: nodes.flatMap((n) => (n['Relation Name'] ? [n['Relation Name']] : [])),
    // The root node's counts include its children's.
    buffers: (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
  };
}
