import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { URLSearchParams } from "node:url";
import open from "open";

function getPackageInfo(cwd: string) {
	const pkgPath = resolve(cwd, "package.json");
	const pkgRaw = readFileSync(pkgPath, "utf-8");
	return JSON.parse(pkgRaw);
}

async function main() {
	const cwd = process.cwd();
	const pkg = getPackageInfo(cwd);

	const version = pkg.version;
	const repoUrl = pkg.repository?.url;

	if (!repoUrl || !repoUrl.startsWith("https://github.com/")) {
		console.error("❌ Missing or invalid repository.url in package.json");
		process.exit(1);
	}

	const params = new URLSearchParams({
		tag: `v${version}`,
		title: `v${version}`,
	});

	const newReleaseUrl = `${repoUrl.replace(/\.git$/, "")}/releases/new?${params.toString()}`;

	console.log(`🔗 Opening: ${newReleaseUrl}`);
	await open(newReleaseUrl);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
