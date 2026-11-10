import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runPythonProject} from './index.mjs';

const opts={pythonExecutable:process.env.XI_TRUSTED_PYTHON,sandboxRoot:fs.mkdtempSync(path.join(os.tmpdir(),'python-component-'))};
const input={
  'src/example.py':'def double(x):\n    return x*2\n',
  'tests/test_example.py':'from example import double\nimport unittest\nclass Example(unittest.TestCase):\n    def test_four(self):\n        self.assertEqual(double(2),4)\n'
};
const test='tests/test_example.py';
const result=await runPythonProject({...opts,files:input,test});
assert.equal(result.tests,1);assert.equal(result.exitCode,0);assert.equal(result.network,false);
await assert.rejects(runPythonProject({...opts,files:{...input,'src/example.py':'def double(x): return x'},test}),/test_four/);
await assert.rejects(runPythonProject({...opts,files:{'tests/empty.py':'import unittest'},test:'tests/empty.py'}),/未发现/);
await assert.rejects(runPythonProject({...opts,files:{...input,'../outside.py':''},test}),/路径无效/);
assert.deepEqual(fs.readdirSync(opts.sandboxRoot),[]);
fs.rmdirSync(opts.sandboxRoot);
console.log(JSON.stringify({result,failingOriginalRejected:true,emptySuiteRejected:true,traversalRejected:true,scratchRunsLeft:0}));
