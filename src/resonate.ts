import {
  Codec,
  ConsoleLogger,
  Core,
  type Encryptor,
  type Func,
  isExecuteMsg,
  type Logger,
  type LogLevel,
  NoopEncryptor,
  NoopHeartbeat,
  OptionsBuilder,
  Registry,
  WallClock,
} from "@resonatehq/sdk";
import { SupabaseNetwork } from "./network.ts";

function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

export class Resonate {
  private registry: Registry;
  private codec: Codec;
  private idPrefix: string;
  private logger: Logger;
  private pid: string;
  private dependencies: Map<string, any>;
  private connectionString?: string;
  private ttl: number;

  /**
   * Creates a new Resonate client instance.
   *
   * @param options - Configuration options for the client.
   * @param options.pid - Process identifier for the client. Defaults to a random UUID.
   * @param options.ttl - Time-to-live (in ms) for acquired tasks. The server will release
   *   a task if no heartbeat is received within this window. Defaults to `5 * 60 * 1000`
   *   (5 minutes). Set this to at least the maximum expected function execution time.
   *   Because serverless functions cannot send async heartbeats, choose a value safely
   *   above your function's configured timeout.
   * @param options.connectionString - Postgres connection string for the resonate-pg
   *   server (the Resonate server running inside your Supabase database). Defaults to
   *   the `SUPABASE_DB_URL` env var, which Supabase Edge Functions provide automatically.
   * @param options.verbose - Enables verbose logging (shorthand for `logLevel: "debug"`). Defaults to `false`.
   * @param options.logLevel - Log level for the default ConsoleLogger. Defaults to `"warn"`. Takes precedence over `verbose`.
   * @param options.logger - Custom logger implementation. Defaults to {@link ConsoleLogger}.
   * @param options.encryptor - Payload encryptor. Defaults to {@link NoopEncryptor}.
   * @param options.prefix - ID prefix applied to generated IDs. Defaults to
   *   `Deno.env.get("RESONATE_PREFIX")` when set.
   */
  constructor({
    pid = undefined,
    ttl = 5 * 60 * 1000,
    connectionString = undefined,
    verbose = false,
    logLevel = undefined,
    logger = undefined,
    encryptor = undefined,
    prefix = undefined,
  }: {
    pid?: string;
    ttl?: number;
    connectionString?: string;
    verbose?: boolean;
    logLevel?: LogLevel;
    logger?: Logger;
    encryptor?: Encryptor;
    prefix?: string;
  } = {}) {
    this.codec = new Codec(encryptor ?? new NoopEncryptor());
    const resolvedPrefix = prefix ?? Deno.env.get("RESONATE_PREFIX");
    this.idPrefix = resolvedPrefix ? `${resolvedPrefix}:` : "";
    const resolvedLogLevel: LogLevel = logLevel ?? (verbose ? "debug" : "warn");
    this.logger = logger ?? new ConsoleLogger(resolvedLogLevel);
    this.pid = pid ?? crypto.randomUUID().replace(/-/g, "");
    this.registry = new Registry();
    this.dependencies = new Map();
    this.connectionString = connectionString;
    this.ttl = ttl;
  }

  /**
   * Registers a function with Resonate for execution and version control.
   */
  public register<F extends Func>(
    name: string,
    func: F,
    options?: {
      version?: number;
    },
  ): void;
  public register<F extends Func>(
    func: F,
    options?: {
      version?: number;
    },
  ): void;
  public register<F extends Func>(
    nameOrFunc: string | F,
    funcOrOptions?:
      | F
      | {
        version?: number;
      },
    maybeOptions: {
      version?: number;
    } = {},
  ): void {
    const { version = 1 } = (typeof funcOrOptions === "object" ? funcOrOptions : maybeOptions) ??
      {};
    const func = typeof nameOrFunc === "function" ? nameOrFunc : (funcOrOptions as F);
    const name = typeof nameOrFunc === "string" ? nameOrFunc : func.name;

    this.registry.add(func, name, version);
  }

  /**
   * Registers a named dependency that will be available to all Resonate functions
   * via `context.getDependency(name)`.
   *
   * Use this to inject services, clients, or configuration objects into Resonate
   * functions without tight coupling.
   *
   * @param name - A unique key identifying the dependency.
   * @param obj - The dependency value (any object or primitive).
   */
  public setDependency(name: string, obj: any): void {
    this.dependencies.set(name, obj);
  }

  public async handler(req: Request): Promise<Response> {
    try {
      if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
          status: 405,
        });
      }

      const body: any = await req.json();

      if (!body) {
        return new Response(JSON.stringify({ error: "Request body missing." }), {
          status: 400,
        });
      }

      if (!isExecuteMsg(body)) {
        return new Response(
          JSON.stringify({ error: "Request body must be a valid execute message." }),
          { status: 400 },
        );
      }

      // Talk to the resonate-pg server (a Resonate server that lives entirely in
      // the Postgres database) directly over the connection this function already
      // has -- each request is a `SELECT resonate.resonate_rpc(...)`. No separate
      // Resonate HTTP server; delivery still arrives by pg_net HTTP push.
      const network = new SupabaseNetwork({
        connectionString: this.connectionString,
        logger: this.logger,
      });

      // The function's own public URL — used as the anycast address so
      // sub-tasks are routed back to this same function invocation.
      // Prefer FUNCTION_URL env var, then reconstruct from forwarded headers.
      const functionUrl = Deno.env.get("FUNCTION_URL") ?? buildForwardedURL(req);

      const core = new Core({
        pid: this.pid,
        ttl: this.ttl,
        clock: new WallClock(),
        send: network.send,
        codec: this.codec,
        registry: this.registry,
        heartbeat: new NoopHeartbeat(),
        dependencies: this.dependencies,
        optsBuilder: new OptionsBuilder({
          match: (target: string): string => {
            if (isUrl(target)) return target;
            return functionUrl;
          },
          idPrefix: this.idPrefix,
        }),
        logger: this.logger,
      });

      const status = await core.onMessage(body);

      if (status.kind === "done") {
        return new Response(JSON.stringify({ status: "completed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ status: "suspended" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: `Handler failed: ${error}` }),
        { status: 500 },
      );
    }
  }

  public httpHandler(): unknown {
    return Deno.serve(async (req: Request) => {
      return await this.handler(req);
    });
  }
}

function buildForwardedURL(req: Request) {
  const headers = req.headers;
  const url = new URL(req.url);

  // 1. Hostname Logic
  // Dev: "x-forwarded-host" is present (e.g., 127.0.0.1)
  // Prod: "x-forwarded-host" is missing, so we use url.hostname (e.g., project.supabase.co)
  const forwardedHost = headers.get("x-forwarded-host");
  const host = forwardedHost ?? url.hostname;

  // 2. Protocol Logic
  // Always prefer "x-forwarded-proto" (usually https in prod), fallback to "http"
  const proto = headers.get("x-forwarded-proto") ?? "http";

  // 3. Port Logic
  // Dev: We need the port (e.g., :54321).
  // Prod: We rarely need :443 explicitly in the URL string.
  const forwardedPort = headers.get("x-forwarded-port");
  const port = forwardedHost && forwardedPort ? `:${forwardedPort}` : "";

  // 4. Path Logic
  // Dev: "x-forwarded-path" contains the full path (/functions/v1/hello-world)
  // Prod: We must use url.pathname.
  let path = headers.get("x-forwarded-path") ?? url.pathname;

  // 5. Production Path Fix
  // In Prod, the internal req.url often strips '/functions/v1'.
  // We re-add it if we are in Prod (no forwardedHost) and it's missing.
  if (!forwardedHost && !path.startsWith("/functions/v1")) {
    path = `/functions/v1${path}`;
  }

  return `${proto}://${host}${port}${path}`;
}
