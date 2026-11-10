import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {runContainer} from './container.mjs';

const execute = promisify(execFile);
const runnerSource=fileURLToPath(new URL('../dsh/AppContainerRunner.cs',import.meta.url));
const packer = fileURLToPath(new URL('./pack-runtime.py',import.meta.url));
const pythonSha = 'd932e5e2f324d57f392e8fd063dcf6d0185be8a664c57c6d24e7762ed02c28ca';
const sourceSha='e6cc2896b6142abcb91fe69873741d09f5eac2e193c2117058db5b5da4291edf';
const runtimeSha = 'ab56e4d12e925c3aeec3e3149495108e5746621548b848656afacd730690b4a7';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requireTrue = (flag, message) => { if(!flag) throw Error(message); };
function safe(name) {
  return typeof name === 'string' && name.length<=96 && name.split('/').length<=4 &&
    name.split('/').every(n=>/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(n) && !n.endsWith('.') &&
      !/^(?:aux|nul|con|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n));
}
export async function runPythonProject({files,test,sandboxRoot,pythonExecutable:python,signal}) {
  requireTrue(typeof sandboxRoot==='string' && path.isAbsolute(sandboxRoot) && typeof python==='string' && path.isAbsolute(python),'需要受信任的运行路径');
  requireTrue(files && typeof files==='object' && !Array.isArray(files) && Object.keys(files).length<=24 &&
    Object.values(files).every(text=>typeof text==='string' && Buffer.byteLength(text)<=32000) && Buffer.byteLength(JSON.stringify(files))<=96000,'超出已选文件数或字节上限');
  requireTrue(safe(test) && test.endsWith('.py') && Object.hasOwn(files,test),'缺少只读 unittest 测试文件');
  requireTrue(sha(fs.readFileSync(runnerSource))===sourceSha && sha(fs.readFileSync(python))===pythonSha,'Python 或隔离器版本已变化，请重新验证');
  fs.mkdirSync(sandboxRoot,{recursive:true});
  const temp=fs.mkdtempSync(path.join(sandboxRoot,'python-'));
  const work=path.join(temp,'project'), runtime=path.join(temp,'runtime');
  const deadline=AbortSignal.timeout(60000);
  const combined=signal?AbortSignal.any([signal,deadline]):deadline;
  try {
    fs.mkdirSync(work); fs.mkdirSync(runtime);
    const runner=path.join(temp,'AppContainerRunner.exe');
    const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const source=path.join(temp,'AppContainerRunner.cs');
    const bytes=fs.readFileSync(runnerSource);
    requireTrue(sha(bytes)===sourceSha,'隔离器源码摘要变化');
    fs.writeFileSync(source,bytes,{flag:'wx'});
    await execute(compiler,['/nologo','/target:exe','/optimize+','/out:'+runner,source],{
      cwd:temp,signal:combined,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,TEMP:temp,TMP:temp},maxBuffer:32000
    });
    for(const [name,value] of Object.entries(files)) {
      requireTrue(safe(name) && typeof value==='string','选定文件路径无效');
      const dest=path.join(work,name);
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      fs.writeFileSync(dest,value,{flag:'wx'});
    }
    const {stdout}=await execute(python,['-I','-S',packer,runtime],{
      cwd:path.dirname(python),signal:combined,windowsHide:true,
      env:{SystemRoot:process.env.SystemRoot, TEMP:temp, TMP:temp},maxBuffer:4096
    });
    requireTrue(stdout.trim()===runtimeSha,'Python 标准库或 DLL 摘要变化');
    const entry='.xi-unittest.py';
    const launcher=[
      'import importlib.util, json, pathlib, sys, unittest',
      'root = pathlib.Path.cwd()',
      'target = root / '+JSON.stringify(test),
      'sys.dont_write_bytecode = True',
      "sys.path[:0] = [str(root), str(root/'src'), str(target.parent)]",
      "name = target.stem",
      "p = target.parent",
      "while (p/'__init__.py').is_file() and p != root:",
      "    name = p.name + '.' + name",
      "    p = p.parent",
      'spec = importlib.util.spec_from_file_location(name,target)',
      'module = importlib.util.module_from_spec(spec)',
      'sys.modules[name] = module',
      'spec.loader.exec_module(module)',
      'suite = unittest.defaultTestLoader.loadTestsFromModule(module)',
      'result = unittest.TextTestRunner().run(suite)',
      "count = result.testsRun",
      "passed = result.wasSuccessful() and count > len(result.skipped)",
      "with open('.xi-result.json','x') as output:",
      "    json.dump({'count':count, 'passed':passed},output)",
      'raise SystemExit(0 if passed else 1)'
    ].join('\n');
    fs.writeFileSync(path.join(work,entry),launcher,{flag:'wx'});
    const evidence=await runContainer({runner,work,executable:path.join(runtime,'python.exe'),test:entry,cancel:path.join(temp,'cancel'),signal:combined});
    const resultPath=path.join(work,'.xi-result.json'),st=fs.lstatSync(resultPath);
    requireTrue(st.isFile() && !st.isSymbolicLink() && st.nlink===1 && st.size<=2048,'缺少 unittest 结果');
    const result=JSON.parse(fs.readFileSync(resultPath,'utf8'));
    requireTrue(result.passed===true && Number.isSafeInteger(result.count) && result.count>0,'原测试未实际执行');
    return {...evidence,tests:result.count,python:'3.13',test,originalSha256:sha(files[test])};
  } catch(error) {
    if (!String(error.message).startsWith('原测试失败')) throw error;
    // Only relay test method names and exception classes from bounded sandbox output.
    const log=path.join(work,'.stderr.log');
    let hint='';
    try {
      const stat=fs.lstatSync(log);
      if(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1 && stat.size<=65536) {
        const content=fs.readFileSync(log,'utf8');
        const methods=[...content.matchAll(/^(?:ERROR|FAIL): (test_[a-zA-Z0-9_]{1,100})\b/gm)].map(m=>m[1]);
        const causes=[...content.matchAll(/^(?:[a-zA-Z_]\w*\.)*([A-Z][a-zA-Z0-9_]{1,60}(?:Error|Exception)):/gm)].map(m=>m[1]);
        hint=[...new Set([...methods,...causes])].slice(0,8).join(', ');
        if(content.includes('Ran 0 tests')) hint='未发现 unittest 用例';
      }
    } catch {}
    throw Error(error.message+(hint?'；'+hint:''));
  } finally {
    if(path.dirname(temp)===path.resolve(sandboxRoot) && path.basename(temp).startsWith('python-'))
      fs.rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
