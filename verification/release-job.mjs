#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { assertVersion, authorizeInstall, authorizePromotion, authorizePromotionObservation, authorizeUpload, beginPromotion, classifyPromotionObservation, hashBytes, planFinalization, PROMOTION_ERROR_CODES, recordPromotion, writeExclusive } from "./release-control.mjs";
export const PROMOTION_OBSERVATION = "bounded-latest-v1";
const OBSERVATION_MS=60000, POLL_MS=5000, MIN_READ_MS=1000;
const wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
let readConfig;
export function latestReadOptions(timeout){
  if(!readConfig){
    const root=mkdtempSync(join(tmpdir(),"slate-latest-")),user=join(root,"user.npmrc"),global=join(root,"global.npmrc");
    process.once("exit",()=>rmSync(root,{recursive:true,force:true}));
    for(const file of [user,global])writeFileSync(file,"",{flag:"wx",mode:0o600});
    readConfig={root,user,global};
  }
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/token|auth|password/i.test(k)&&!/^npm_config_(userconfig|globalconfig)$/i.test(k)));
  return{timeout,killSignal:"SIGKILL",cwd:readConfig.root,env:{...env,npm_config_userconfig:readConfig.user,npm_config_globalconfig:readConfig.global}};
}
const latestView=(registry,options)=>{const raw=capture("npm",["view","ytdb-slate","dist-tags.latest","--json","--fetch-retries=0",`--fetch-timeout=${options.timeout}`,"--registry",registry],options);try{const value=JSON.parse(raw);if(typeof value!=="string")throw new Error("invalid latest");return assertVersion(value);}catch{throw new Error("latest response is malformed");}};
const readLatest=(view,registry,timeout)=>{try{const value=view(registry,latestReadOptions(timeout));if(typeof value!=="string")throw new Error("invalid latest");return assertVersion(value);}catch(error){throw new Error(error?.code==="ETIMEDOUT"?"latest read timed out":"latest read failed or returned malformed data",{cause:error});}};
export function observeLatest({registry,version,expectedLatest,view=latestView,now=()=>performance.now(),sleep=wait,allowance=OBSERVATION_MS,interval=POLL_MS}){
  if(!Number.isFinite(allowance)||allowance<=0||allowance>OBSERVATION_MS||!Number.isFinite(interval)||interval<=0)throw new Error("invalid observation timing");
  const deadline=now()+allowance;let latest;
  for(;;){
    const remaining=Math.floor(deadline-now());if(remaining<Math.min(MIN_READ_MS,allowance/2)){if(latest===undefined)throw new Error("latest observation timed out");return{result:classifyPromotionObservation(latest,version,expectedLatest),after:latest};}
    latest=readLatest(view,registry,remaining);if(now()>=deadline)throw new Error("latest read timed out");
    if(latest===version)return{result:"verified",after:latest};
    sleep(Math.min(interval,deadline-now()));
  }
}
export function promotionErrorCode(error){const codes=[];if(error?.name==="TimeoutError"||error?.name==="AbortError")codes.push("ETIMEDOUT");if(typeof error?.cause?.code==="string")codes.push(error.cause.code);try{const code=JSON.parse(String(error?.stdout??""))?.error?.code;if(typeof code==="string")codes.push(code);}catch{}if(typeof error?.code==="string")codes.push(error.code);for(const match of String(error?.stderr??"").matchAll(/^npm (?:ERR!|error) code ([A-Z0-9_]+)\s*$/gm))codes.push(match[1]);const unique=[...new Set(codes)];return unique.length===1&&PROMOTION_ERROR_CODES.includes(unique[0])?unique[0]:"unknown";}
const reportPromotion=result=>{if(result.result!=="verified")console.log("::error::Promotion is not verified. Inspect the saved result before recovery.");};
const readJson=p=>JSON.parse(readFileSync(p,"utf8"));
const run=(command,args,options={})=>{const r=spawnSync(command,args,{encoding:"utf8",timeout:120000,...options});if(r.error)throw r.error;if(r.status!==0){const error=new Error(`${command} failed with status ${r.status}: ${r.stderr??""}`);error.stderr=r.stderr??"";error.stdout=r.stdout??"";error.status=r.status;throw error;}return r;};
const capture=(command,args,options={})=>execFileSync(command,args,{encoding:"utf8",timeout:120000,...options}).trim();
const args=xs=>{const x={_:[]};for(let i=0;i<xs.length;i++){if(xs[i].startsWith("--"))x[xs[i].slice(2)]=xs[++i];else x._.push(xs[i]);}return x;};
const requireNoToken=()=>{for(const k of Object.keys(process.env))if(/NODE_AUTH_TOKEN|NPM_TOKEN|PROMOTION_TOKEN/i.test(k))throw new Error(`credential ${k} is forbidden in this job`);};
const expected=a=>({identity:a.identity,version:a.version,releaseSha:a.sha,releaseParent:a.parent});
export function executeUpload({state,expected:owner,archive,runId,runAttempt,registry,npmVersion=()=>capture("npm",["--version"]),exec=run}){const auth=authorizeUpload(state,owner,runId,runAttempt),file=resolve(archive);if(!statSync(file).isFile())throw new Error("upload archive must be an existing regular file");const actual=hashBytes(readFileSync(file)),[major,minor,patch]=npmVersion().split(".").map(Number);if(major<11||(major===11&&(minor<5||(minor===5&&patch<1))))throw new Error("npm 11.5.1 or newer is required");if(basename(file)!==auth.artifact.file||actual.sha256!==auth.artifact.sha256||actual.integrity!==auth.artifact.integrity)throw new Error("sealed archive bytes differ");exec("npm",["publish",file,"--tag",auth.internalTag,"--ignore-scripts","--provenance=false","--registry",registry]);return auth;}
const maskCredential=value=>console.log(`::add-mask::${value.replaceAll("%","%25").replaceAll("\r","%0D").replaceAll("\n","%0A")}`);
async function writeLatestOidc(version,env,fetch,mask){
  const request=async(url,options,status)=>{
    const response=await fetch(url,{...options,redirect:"error",signal:AbortSignal.timeout(10000)});
    if(!response.ok||response.status!==status)throw Object.assign(new Error("promotion request failed"),{code:`E${response.status}`});
    return response;
  };
  const credential=async(response,key)=>{
    const value=(await response.json())?.[key];
    if(typeof value!=="string"||!value)throw new Error("promotion credential is malformed");
    mask(value);
    if(/[\r\n]/.test(value))throw new Error("promotion credential is malformed");
    return value;
  };
  const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if(url.protocol!=="https:")throw new Error("promotion requires HTTPS");
  url.searchParams.set("audience","npm:registry.npmjs.org");
  const idToken=await credential(await request(url.href,{method:"GET",headers:{Accept:"application/json",Authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}},200),"value");
  const token=await credential(await request("https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/ytdb-slate",{method:"POST",headers:{Accept:"application/json",Authorization:`Bearer ${idToken}`}},201),"token");
  const response=await fetch("https://registry.npmjs.org/-/package/ytdb-slate/dist-tags/latest",{method:"PUT",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(version),redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Object.assign(new Error("promotion request failed"),{code:`E${response.status}`});
}
export async function executePromotion({state,expected:owner,runId,runAttempt,registry,oidcEnv=process.env,fetch=globalThis.fetch,mask=maskCredential,view=latestView,...timing}){
  const auth=authorizePromotion(state,owner,runId,runAttempt),envelope={identity:auth.identity,releaseSha:auth.releaseSha,execution:auth.execution};
  if(!oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL||!oidcEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN)return{...envelope,result:"not-attempted",cause:"missing-token"};
  try{if(new URL(registry).origin!=="https://registry.npmjs.org")throw new Error("registry origin differs");}catch{return{...envelope,result:"refused",before:auth.expectedLatest,errorCode:"unknown"};}
  const before=readLatest(view,registry,OBSERVATION_MS);
  if(before===auth.version)return{...envelope,result:"verified",before:auth.expectedLatest,after:before};
  if(before===auth.expectedLatest){try{await writeLatestOidc(auth.version,oidcEnv,fetch,mask);}catch(error){
    const refused={...envelope,result:"refused",before,errorCode:promotionErrorCode(error)};
    let observed;try{observed=observeLatest({registry,version:auth.version,expectedLatest:auth.expectedLatest,view,...timing});}catch{return refused;}
    return observed.result==="verified"?{...envelope,before,...observed}:{...refused,after:observed.after};
  }}
  return{...envelope,before:auth.expectedLatest,...observeLatest({registry,version:auth.version,expectedLatest:auth.expectedLatest,view,...timing})};
}
export function executePromotionRecovery({state,expected:owner,runId,runAttempt,registry,now=()=>performance.now(),sleep=wait,view=latestView,...timing}){
  const auth=authorizePromotionObservation(state,owner),result={identity:auth.identity,releaseSha:auth.releaseSha,execution:auth.execution,before:auth.expectedLatest,...observeLatest({registry,version:auth.version,expectedLatest:auth.expectedLatest,view,now,sleep,...timing})};
  const observed=recordPromotion(state,result,owner,new Date().toISOString()),retryPromotion=result.result==="unchanged";
  return{result,retryPromotion,state:retryPromotion?beginPromotion(observed,auth.expectedLatest,owner,runId,runAttempt,new Date().toISOString()):observed};
}
export function executeInstall({state,expected:owner,runId,runAttempt,workspace,out,failureOut,exec=run}){requireNoToken();const auth=authorizeInstall(state,owner,runId,runAttempt),root=resolve(workspace);mkdirSync(root,{recursive:true});const project=`${root}/project`,agent=`${root}/agent`,cache=`${root}/cache`;for(const p of[project,agent,cache])mkdirSync(p,{recursive:true});const pi=process.env.PI_BIN||"pi",baseEnv={PATH:process.env.PATH??"",HOME:root,PI_CODING_AGENT_DIR:agent,npm_config_cache:cache,npm_config_registry:process.env.REGISTRY??"https://registry.npmjs.org/"};let failure="install-command";try{exec(pi,["install","-l",`npm:ytdb-slate@${state.version}`,"-a"],{cwd:project,env:baseEnv});failure="command-proof";const rpc=exec(pi,["--mode","rpc","-a"],{cwd:project,env:{...baseEnv,PI_OFFLINE:"1"},input:'{"id":"1","type":"get_commands"}\n'});const events=String(rpc?.stdout??"").trim().split("\n").filter(Boolean).map(JSON.parse),response=events.find(x=>x.type==="response"&&x.command==="get_commands"),commands=response?.data?.commands?.filter(x=>x.name==="slate");if(events.some(x=>x.type==="extension_error")||commands?.length!==1)throw new Error("installed extension did not register one /slate command");const proof={...auth,proof:{command:"slate",source:commands[0].sourceInfo?.source}};if(proof.proof.source!==`npm:ytdb-slate@${state.version}`)throw new Error("installed extension source differs from exact version");writeFileSync(out,JSON.stringify(proof,null,2)+"\n");return proof;}catch(error){if(failureOut)writeFileSync(failureOut,JSON.stringify({...auth,result:"failed",failure},null,2)+"\n");throw error;}}
export function executeFinalRecords({state,expected:owner,notes,repo,tagSha="",releaseTarget="",exec=run}){requireNoToken();const plan=planFinalization({state,expected:owner,remoteTagSha:tagSha,releaseTarget});if(plan.createTag)exec("git",["tag",plan.tag,plan.target]);if(plan.createTag)exec("git",["push","origin",`refs/tags/${plan.tag}`]);if(plan.createRelease)exec("gh",["release","create",plan.tag,"--repo",repo,"--verify-tag","--target",plan.target,"--title",`ytdb-slate ${state.version}`,"--notes-file",notes]);return plan;}
async function main(){const[cmd,...rest]=process.argv.slice(2),a=args(rest),state=a.state?readJson(a.state):null,owner=expected(a);if(!cmd||cmd==="--help"){console.log("release-job commands: upload promote recover-promotion install final-records");return;}if(cmd==="upload")executeUpload({state,expected:owner,archive:a.archive,runId:a["run-id"],runAttempt:a["run-attempt"],registry:a.registry});else if(cmd==="promote"){const result=await executePromotion({state,expected:owner,runId:a["run-id"],runAttempt:a["run-attempt"],registry:a.registry});writeFileSync(a.out,JSON.stringify(result,null,2)+"\n");reportPromotion(result);}else if(cmd==="recover-promotion"){const recovered=executePromotionRecovery({state,expected:owner,runId:a["run-id"],runAttempt:a["run-attempt"],registry:a.registry});writeExclusive(a.out,recovered.state);writeExclusive(a["result-out"],recovered.result);writeExclusive(a["decision-out"],{retryPromotion:recovered.retryPromotion});reportPromotion(recovered.result);}else if(cmd==="install")executeInstall({state,expected:owner,runId:a["run-id"],runAttempt:a["run-attempt"],workspace:a.workspace,out:a.out,failureOut:a["failure-out"]});else if(cmd==="final-records")executeFinalRecords({state,expected:owner,notes:a.notes,repo:a.repo,tagSha:a["tag-sha"]||"",releaseTarget:a["release-target"]||""});else throw new Error(`unknown command: ${cmd}`);}
if(resolve(process.argv[1]??"")===resolve(new URL(import.meta.url).pathname))main().catch(e=>{console.error(`release-job: ${e.message}`);process.exitCode=2;});
