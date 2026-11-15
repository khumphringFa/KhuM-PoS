const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const KINDS = {
  'KhuM-PoS-testing-apk': {label: 'Testing', filename: 'app-debug.apk', prerelease: true},
  'KhuM-PoS-signed-release': {label: 'Signed', filename: 'app-release.apk', prerelease: false},
};
const WORKFLOWS = new Set(['.github/workflows/ci.yml', '.github/workflows/release-android.yml']);

module.exports = async function publishApks({github, context, core}) {
  const repo = context.repo;
  const repository = (await github.rest.repos.get(repo)).data;
  const backfill = context.eventName !== 'workflow_run';
  const runs = backfill
    ? await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {...repo, status: 'completed', per_page: 100})
    : [context.payload.workflow_run];
  let published = 0, skipped = 0;
  const failures = [];
  for (const run of runs) {
    // A workflow_run has a privileged token. Never check out a run's source or execute its artifacts.
    if (run.conclusion !== 'success' || !WORKFLOWS.has(run.path?.split('@')[0]) || run.head_repository?.id !== repository.id) continue;
    try {
      const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {...repo, run_id: run.id, per_page: 100});
      for (const artifact of artifacts) {
        const kind = KINDS[artifact.name];
        if (!kind) continue;
        if (artifact.expired) { core.warning(`Build ${run.id}: expired artifact ${artifact.id} cannot be recovered.`); skipped++; continue; }
        const tag = `android-${kind.label.toLowerCase()}-${run.id}`;
        let release;
        try { release = (await github.rest.repos.getReleaseByTag({...repo, tag})).data; }
        catch (e) { if (e.status !== 404) throw e; }
        const assetName = `KhuM-PoS-${kind.label.toLowerCase()}-${run.run_number}-${run.head_sha.slice(0, 8)}-${artifact.id}.apk`;
        if (release) {
          const assets = await github.paginate(github.rest.repos.listReleaseAssets, {...repo, release_id: release.id, per_page: 100});
          if (assets.some(a => a.name === assetName)) { skipped++; continue; }
        }
        // GitHub returns a ZIP containing the APK. Extract a fixed, expected filename, never a path from the ZIP.
        if (artifact.size_in_bytes > 100 * 1024 * 1024) throw Error(`Artifact ${artifact.id} exceeds the publication size limit.`);
        const archive = await github.rest.actions.downloadArtifact({...repo, artifact_id: artifact.id, archive_format: 'zip'});
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khum-apk-'));
        let apk;
        try {
          const zip = path.join(dir, 'artifact.zip'); fs.writeFileSync(zip, Buffer.from(archive.data));
          apk = execFileSync('unzip', ['-p', zip, kind.filename], {maxBuffer: 128 * 1024 * 1024});
          if (apk.length < 4 || apk[0] !== 0x50 || apk[1] !== 0x4b) throw Error(`Artifact ${artifact.id} does not contain an APK ZIP.`);
        } finally { fs.rmSync(dir, {recursive: true, force: true}); }
        if (!release) {
          const description = [
            `Automatically archived ${kind.label.toLowerCase()} APK from [build #${run.run_number}](${run.html_url}).`,
            `Source: \`${run.head_branch}\` · commit \`${run.head_sha}\` · trigger: \`${run.event}\`.`,
            kind.prerelease
              ? '**Testing build (debug-signed).** Not a production-signed release. Export/sync data before replacing an app with a different signing identity.'
              : '**Release-signed build.** Uses the configured permanent Android signing keystore.',
            'Download the `.apk` under Assets. This release copy remains available after the temporary Actions artifact expires.',
          ].join('\n\n');
          release = (await github.rest.repos.createRelease({...repo, tag_name: tag, target_commitish: run.head_sha,
            name: `KhuM PoS · ${kind.label} build #${run.run_number}`,
            body: description, draft: false, prerelease: kind.prerelease, make_latest: kind.prerelease ? 'false' : 'true'})).data;
        }
        await github.rest.repos.uploadReleaseAsset({...repo, release_id: release.id, name: assetName,
          headers: {'content-type': 'application/vnd.android.package-archive', 'content-length': apk.length}, data: apk});
        core.info(`Published ${assetName} to ${release.html_url}`); published++;
      }
    } catch (e) { failures.push(`Build ${run.id}: ${e.message}`); core.error(failures.at(-1)); }
  }
  await core.summary.addHeading('KhuM PoS APK releases')
    .addRaw(`Published ${published} APK(s). Skipped ${skipped} existing/expired artifact(s).\n\n`)
    .addLink('Open Releases', `${repository.html_url}/releases`).write();
  if (failures.length) core.setFailed(failures.join('\n'));
};
