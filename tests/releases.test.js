import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const publish = createRequire(import.meta.url)('../scripts/publish-apks.cjs');
const zip = name => execFileSync('python3', ['-c', 'import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr(sys.argv[1],b"PK\\x03\\x04test"); z.close(); sys.stdout.buffer.write(b.getvalue())', name]);
function fixture(artifacts, overrides={}) {
  const run={id:42,run_number:7,head_sha:'a'.repeat(40),head_branch:'main',head_repository:{id:1},conclusion:'success',path:'.github/workflows/ci.yml',event:'push',html_url:'https://github.com/example/repo/actions/runs/42',...overrides};
  const created=[],uploaded=[],errors=[]; let release;
  const actions={listWorkflowRunsForRepo:()=>{},listWorkflowRunArtifacts:()=>{},downloadArtifact:async ({artifact_id})=>({data:zip(artifacts.find(a=>a.id===artifact_id).name==='KhuM-PoS-signed-release'?'app-release.apk':'app-debug.apk')})};
  const repos={get:async()=>({data:{id:1,html_url:'https://github.com/example/repo'}}),getReleaseByTag:async()=>{if(release)return {data:release};throw Object.assign(Error('not found'),{status:404});},listReleaseAssets:()=>{},createRelease:async args=>{created.push(args);release={id:10,html_url:'https://github.com/example/repo/releases/tag/test'};return {data:release};},uploadReleaseAsset:async args=>uploaded.push(args)};
  const github={rest:{repos,actions},paginate:async fn=>fn===actions.listWorkflowRunArtifacts?artifacts:fn===repos.listReleaseAssets?uploaded: [run]};
  const summary={addHeading(){return this;},addRaw(){return this;},addLink(){return this;},async write(){}};
  const core={summary,info(){},warning(){},error:e=>errors.push(e),setFailed:e=>errors.push(e)};
  return {run,created,uploaded,errors,args:{github,core,context:{repo:{owner:'example',repo:'repo'},eventName:'workflow_run',payload:{workflow_run:run}}}};
}
test('testing APK is published as a prerelease and reruns do not duplicate assets',async()=>{const f=fixture([{id:5,name:'KhuM-PoS-testing-apk',expired:false,size_in_bytes:100}]);await publish(f.args);await publish(f.args);assert.equal(f.created.length,1);assert.equal(f.uploaded.length,1);assert.equal(f.created[0].prerelease,true);assert.equal(f.created[0].make_latest,'false');assert.equal(f.uploaded[0].headers['content-type'],'application/vnd.android.package-archive');assert.equal(f.errors.length,0);});
test('signed APK is a regular release',async()=>{const f=fixture([{id:6,name:'KhuM-PoS-signed-release',expired:false,size_in_bytes:100}],{path:'.github/workflows/release-android.yml'});await publish(f.args);assert.equal(f.created[0].prerelease,false);assert.equal(f.created[0].make_latest,'true');});
test('forks, unsuccessful builds and unrelated workflows cannot publish',async()=>{for(const override of [{head_repository:{id:99}},{conclusion:'failure'},{path:'.github/workflows/unrelated.yml'}]){const f=fixture([{id:5,name:'KhuM-PoS-testing-apk'}],override);await publish(f.args);assert.equal(f.uploaded.length,0);}});
test('backfill skips expired APKs and unrelated artifacts',async()=>{const f=fixture([{id:5,name:'KhuM-PoS-testing-apk',expired:true},{id:6,name:'other-output'}]);f.args.context.eventName='push';await publish(f.args);assert.equal(f.created.length,0);assert.equal(f.errors.length,0);});
