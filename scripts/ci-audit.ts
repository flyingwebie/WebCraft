// Where CI's time goes: every job of the last N workflow runs, split into waiting (queued before a
// runner took it), setup (checkout, Bun, node_modules, services) and running (the check itself),
// at the median and the 95th percentile. Needs the `gh` CLI, signed in.
//
//   bun scripts/ci-audit.ts [runs = 150] [workflow name, e.g. CI]
const limit = Number(process.argv[2] ?? 150);
const only = process.argv[3];

type Step = { name: string; started_at: string | null; completed_at: string | null };
type Job = {
	name: string;
	workflow_name: string;
	conclusion: string | null;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	steps: Step[];
};

const gh = (path: string) => {
	const result = Bun.spawnSync(["gh", "api", path], { stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`gh api ${path} failed`);
	return JSON.parse(result.stdout.toString());
};
const repo = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
	.stdout.toString()
	.trim();

const runs: { id: number; name: string }[] = [];
for (let page = 1; runs.length < limit; page++) {
	const batch = gh(`repos/${repo}/actions/runs?per_page=100&page=${page}`).workflow_runs as {
		id: number;
		name: string;
	}[];
	if (batch.length === 0) break;
	runs.push(...batch.filter((run) => !only || run.name === only));
}
const jobs = runs
	.slice(0, limit)
	.flatMap((run) => gh(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&filter=all`).jobs as Job[]);

const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
// The check itself; everything else a job does is setup.
const isCheck = (step: Step) =>
	/^(Run )?(bun (run|test|scripts)|sh scripts|Check tracked files|bun test|Compile)/.test(step.name) ||
	/actions\/within/.test(step.name);
const rows = new Map<string, { wait: number[]; setup: number[]; run: number[] }>();
for (const job of jobs) {
	if (!job.started_at || !job.completed_at || job.conclusion === "skipped" || job.conclusion === null) continue;
	const key = `${job.workflow_name} / ${job.name.replace(/ \(\d+\/\d+\)$/, "")}`;
	const row = rows.get(key) ?? { wait: [], setup: [], run: [] };
	let run = 0;
	for (const step of job.steps) {
		if (step.started_at && step.completed_at && isCheck(step)) run += seconds(step.started_at, step.completed_at);
	}
	row.wait.push(seconds(job.created_at, job.started_at));
	row.run.push(run);
	row.setup.push(seconds(job.started_at, job.completed_at) - run);
	rows.set(key, row);
}

const percentile = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0);
};
const cell = (values: number[]) => `${percentile(values, 0.5)} / ${percentile(values, 0.95)}`.padStart(11);
console.log(`${runs.slice(0, limit).length} runs, ${jobs.length} jobs. Seconds, p50 / p95.`);
console.log(`${"workflow / job".padEnd(58)} ${"n".padStart(4)}   waiting       setup     running`);
for (const [key, row] of [...rows].sort()) {
	console.log(
		`${key.padEnd(58)} ${String(row.run.length).padStart(4)} ${cell(row.wait)} ${cell(row.setup)} ${cell(row.run)}`,
	);
}
