import type { Logger, Network, Request, Response, Send } from "@resonatehq/sdk";
import postgres from "postgres";

// One pooled client per connection string, cached at module scope so that warm
// edge-function invocations reuse it. postgres() is lazy -- it connects on the
// first query and pools internally -- so we never end it; keeping it warm avoids
// a fresh connect on every invocation.
const clients = new Map<string, ReturnType<typeof postgres>>();

function client(conn: string): ReturnType<typeof postgres> {
  let sql = clients.get(conn);
  if (!sql) {
    // prepare:false keeps us compatible with Supabase's transaction pooler
    // (Supavisor), which does not support prepared statements. Each request is a
    // single self-contained resonate_rpc() call, so transaction pooling is fine.
    sql = postgres(conn, {
      prepare: false,
      max: 1,
      idle_timeout: 30,
      connect_timeout: 15,
    });
    clients.set(conn, sql);
  }
  return sql;
}

export interface SupabaseNetworkConfig {
  /** Postgres connection string. Defaults to the `SUPABASE_DB_URL` env var. */
  connectionString?: string;
  logger?: Logger;
}

/**
 * `SupabaseNetwork` speaks the Resonate wire protocol straight to a **resonate-pg**
 * server -- a complete Resonate server that lives entirely in Postgres, where
 * every protocol action is a stored procedure.
 *
 * There is no separate Resonate HTTP server to call back to: each request is just
 * `SELECT resonate.resonate_rpc($1::jsonb)` over the database connection the edge
 * function already has (`SUPABASE_DB_URL`). Delivery of `execute`/`unblock`
 * messages still arrives by HTTP push (Postgres `pg_net` posts them to the
 * function), so this network only implements the outbound RPC transport, `send`;
 * `recv` is unused (the function is invoked per message, not long-polling).
 */
export class SupabaseNetwork implements Pick<Network, "send"> {
  private sql: ReturnType<typeof postgres>;
  private logger?: Logger;

  constructor({ connectionString, logger }: SupabaseNetworkConfig = {}) {
    const conn = connectionString ?? Deno.env.get("SUPABASE_DB_URL");
    if (!conn) {
      throw new Error(
        "SupabaseNetwork: no Postgres connection string. Pass { connectionString } or set the SUPABASE_DB_URL environment variable.",
      );
    }
    this.sql = client(conn);
    this.logger = logger;
  }

  send: Send = async (req) => {
    this.logger?.debug(
      { network: "supabase", kind: req.kind },
      "SupabaseNetwork.send",
    );
    // Bind the request via sql.json() so it arrives as a jsonb object -- passing
    // a JSON string + ::jsonb instead double-encodes it into a jsonb scalar.
    const rows = await this.sql<
      { res: Extract<Response, { kind: typeof req.kind }> }[]
    >`SELECT resonate.resonate_rpc(${this.sql.json(req satisfies Request)}) AS res`;
    return rows[0].res;
  };

  static async close(connectionString?: string): Promise<void> {
    const conn = connectionString ?? Deno.env.get("SUPABASE_DB_URL");
    const sql = conn ? clients.get(conn) : undefined;
    if (conn && sql) {
      clients.delete(conn);
      await sql.end();
    }
  }
}
