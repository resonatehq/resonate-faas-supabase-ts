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

export class Resonate {
	private registry = new Registry();
	private dependencies = new Map<string, any>();
	private verbose: boolean;
	private encryptor: Encryptor;

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
			console.log("URL", url);
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
			const network = new HttpNetwork({
				headers: {},
				timeout: 60 * 1000, // 60s
				url: body.href.base,
				verbose: this.verbose,
			});

			const resonateInner = new ResonateInner({
				anycastNoPreference: url,
				anycastPreference: url,
				clock: new WallClock(),
				dependencies: this.dependencies,
				handler: new Handler(network, encoder, this.encryptor),
				heartbeat: new NoopHeartbeat(),
				network,
				pid: `pid-${Math.random().toString(36).substring(7)}`,
				registry: this.registry,
				ttl: 30 * 1000, // 30s
				unicast: url,
				verbose: this.verbose,
			});

			const task: Task = { kind: "unclaimed", task: body.task };

			const completion: Promise<Response> = new Promise((resolve) => {
				resonateInner.process(task, (error, status) => {
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
				});
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
}

function buildForwardedURL(req: Request) {
	const proto = req.headers.get("x-forwarded-proto") ?? "http";
	const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
	const port = req.headers.get("x-forwarded-port");
	const path = req.headers.get("x-forwarded-path");

	return `${proto}://${host}${port ? `:${port}` : ""}${path}`;
}
