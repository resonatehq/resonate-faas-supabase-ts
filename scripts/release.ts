async function getPackageInfo(cwd: string) {
  const pkgPath = `${cwd}/deno.json`;
  const pkgRaw = await Deno.readTextFile(pkgPath);
  return JSON.parse(pkgRaw);
}

async function main() {
  const cwd = Deno.cwd();
  const pkg = await getPackageInfo(cwd);

  const version = pkg.version;

  const repoUrl = "https://github.com/resonatehq/resonate-faas-supabase-ts";

  const params = new URLSearchParams({
    tag: `v${version}`,
    title: `v${version}`,
  });

  const newReleaseUrl = `${repoUrl}/releases/new?${params.toString()}`;

  console.log(`🔗 Opening: ${newReleaseUrl}`);

  const cmd = new Deno.Command("open", { args: [newReleaseUrl] });
  await cmd.output();
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
