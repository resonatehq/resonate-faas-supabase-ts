import {
	type Func,
	Handler,
	HttpNetwork,
	JsonEncoder,
	NoopHeartbeat,
	Registry,
	ResonateInner,
	type Task,
	WallClock,
} from "@resonatehq/sdk";
import {
	type Encryptor,
	NoopEncryptor,
} from "@resonatehq/sdk/dist/src/encryptor";
import { OptionsBuilder } from "@resonatehq/sdk/dist/src/options";
import { NoopTracer } from "@resonatehq/sdk/dist/src/tracer";
import type { Value } from "@resonatehq/sdk/dist/src/types";
import { assertDefined } from "@resonatehq/sdk/dist/src/util";

export class Resonate {
	private registry = new Registry();
	private dependencies = new Map<string, any>();
	private verbose: boolean;
	private encryptor: Encryptor;
	private onTerminateFn?: (
		result:
			| { status: "completed"; result: Value<string> }
			| { status: "suspended"; result: string[] },
	) => void;

	constructor({
		verbose = false,
		encryptor = undefined,
	}: { verbose?: boolean; encryptor?: Encryptor } = {}) {
		this.verbose = verbose;
		this.encryptor = encryptor ?? new NoopEncryptor();
	}

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
		const { version = 1 } =
			(typeof funcOrOptions === "object" ? funcOrOptions : maybeOptions) ?? {};
		const func =
			typeof nameOrFunc === "function" ? nameOrFunc : (funcOrOptions as F);
		const name = typeof nameOrFunc === "string" ? nameOrFunc : func.name;

		this.registry.add(func, name, version);
	}

	public setDependency(name: string, obj: any): void {
		this.dependencies.set(name, obj);
	}
	public onTerminate(
		fn: (
			result:
				| { status: "completed"; result: Value<string> }
				| { status: "suspended"; result: string[] },
		) => void,
	): void {
		this.onTerminateFn = fn;
	}

	public async handler(req: Request): Promise<Response> {
		try {
			if (req.method !== "POST") {
				return new Response(
					JSON.stringify({ error: "Method not allowed. Use POST." }),
					{
						status: 405,
					},
				);
			}

			const url = buildForwardedURL(req);
			const body: any = await req.json();

			if (!req.body) {
				return new Response(
					JSON.stringify({
						error: "Request body missing.",
					}),
					{
						status: 400,
					},
				);
			}

			if (
				!body ||
				!(body.type === "invoke" || body.type === "resume") ||
				!body.task
			) {
				return new Response(
					JSON.stringify({
						error:
							'Request body must contain "type" and "task" for Resonate invocation.',
					}),
					{
						status: 400,
					},
				);
			}

			const encoder = new JsonEncoder();
			const clock = new WallClock();
			const tracer = new NoopTracer();
			const network = new HttpNetwork({
				headers: {},
				timeout: 60 * 1000, // 60s
				url: body.href.base,
				verbose: this.verbose,
			});

			const resonateInner = new ResonateInner({
				unicast: url,
				anycast: url,
				pid: `pid-${Math.random().toString(36).substring(7)}`,
				ttl: 30 * 1000,
				clock,
				network,
				handler: new Handler(network, encoder, this.encryptor),
				registry: this.registry,
				heartbeat: new NoopHeartbeat(),
				dependencies: this.dependencies,
				optsBuilder: new OptionsBuilder({
					match: (_: string): string => url,
				}),
				verbose: this.verbose,
				tracer,
			});

			const task: Task = { kind: "unclaimed", task: body.task };

			const completion: Promise<Response> = new Promise((resolve) => {
				resonateInner.process(
					tracer.startSpan(task.task.rootPromiseId, clock.now()),
					task,
					(error, status) => {
						if (error || !status) {
							resolve(
								new Response(
									JSON.stringify({
										error: "Task processing failed",
										details: { error, status },
									}),
									{
										status: 500,
									},
								),
							);
							return;
						}

						if (status.kind === "completed") {
							assertDefined(status.promise.value);
							this.onTerminateFn?.({
								status: "completed",
								result: status.promise.value,
							});

							resolve(
								new Response(
									JSON.stringify({
										status: "completed",
										result: status.promise.value,
										requestUrl: url,
									}),
									{
										status: 200,
									},
								),
							);
							return;
						} else if (status.kind === "suspended") {
							this.onTerminateFn?.({
								status: "suspended",
								result: status.callbacks.map((callback) => callback.promiseId),
							});

							resolve(
								new Response(
									JSON.stringify({
										status: "suspended",
										requestUrl: url,
									}),
									{
										status: 200,
									},
								),
							);
							return;
						}
					},
				);
			});
			return completion;
		} catch (error) {
			return new Response(
				JSON.stringify({
					error: `Handler failed: ${error}`,
				}),
				{ status: 500 },
			);
		}
	}

	public httpHandler(): Deno.HttpServer {
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
