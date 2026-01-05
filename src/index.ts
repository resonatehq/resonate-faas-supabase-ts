import {
	Context,
	type Encryptor,
	type Func,
	Handler,
	HttpNetwork,
	JsonEncoder,
	NoopEncryptor,
	NoopHeartbeat,
	NoopTracer,
	OptionsBuilder,
	Registry,
	ResonateInner,
	type Task,
	WallClock,
} from "@resonatehq/sdk";

type OnTerminateCallback = (
	result:
		| { status: "completed"; result?: any }
		| { status: "suspended"; waitingOn: string[] },
) => Promise<void>;

export { Context };

export class Resonate {
	private registry = new Registry();
	private dependencies = new Map<string, any>();
	private verbose: boolean;
	private encryptor: Encryptor;
	private encoder: JsonEncoder;

	constructor({
		verbose = false,
		encryptor = undefined,
	}: { verbose?: boolean; encryptor?: Encryptor } = {}) {
		this.verbose = verbose;
		this.encryptor = encryptor ?? new NoopEncryptor();
		this.encoder = new JsonEncoder();
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

	public async handler(
		req: Request,
		onTerminate?: OnTerminateCallback,
	): Promise<Response> {
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
				handler: new Handler(network, this.encoder, this.encryptor),
				registry: this.registry,
				heartbeat: new NoopHeartbeat(),
				dependencies: this.dependencies,
				optsBuilder: new OptionsBuilder({
					match: (_: string): string => url,
					idPrefix: "",
				}),
				verbose: this.verbose,
				tracer,
			});

			const task: Task = { kind: "unclaimed", task: body.task };

			return new Promise<
				| { status: "completed"; result?: any }
				| { status: "suspended"; waitingOn: string[] }
			>((resolve, reject) => {
				resonateInner.process(
					tracer.startSpan(task.task.rootPromiseId, clock.now()),
					task,
					(error, status) => {
						if (error || !status) {
							return reject({
								error: "Task processing failed",
								details: { error, status },
							});
						}

						return resolve({
							...(status.kind === "completed"
								? { status: status.kind, result: status.promise.value }
								: {
										status: status.kind,
										waitingOn: status.callbacks.map((cb) => cb.promiseId),
									}),
						});
					},
				);
			})
				.then(async (res) => {
					try {
						await onTerminate?.(this.decrypt(res));
					} catch (e) {
						console.error("onTerminate failed", e);
					}
					return new Response(
						JSON.stringify({
							...res,
							requestUrl: url,
						}),
						{ status: 200 },
					);
				})
				.catch((err) => {
					return new Response(JSON.stringify(err), { status: 500 });
				});
		} catch (error) {
			return new Response(
				JSON.stringify({
					error: `Handler failed: ${error}`,
				}),
				{ status: 500 },
			);
		}
	}

	private decrypt(
		res:
			| { status: "completed"; result?: any }
			| { status: "suspended"; waitingOn: string[] },
	):
		| { status: "completed"; result?: any }
		| { status: "suspended"; waitingOn: string[] } {
		if (res.status !== "completed") return res;

		return {
			...res,
			result: this.encoder.decode(this.encryptor.decrypt(res.result)),
		};
	}

	public httpHandler(onTerminate?: OnTerminateCallback): Deno.HttpServer {
		return Deno.serve(async (req: Request) => {
			return await this.handler(req, onTerminate);
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
