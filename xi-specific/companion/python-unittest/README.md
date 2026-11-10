# Windows Python unittest runner

This component runs one repository test file against the selected source files in a zero-capability Windows AppContainer. Its consumer supplies UTF-8 source text, the exact read-only original test path, a private scratch directory, and a trusted local interpreter path. The runner returns a test count, exit status, elapsed time and original-test SHA-256. It rejects an empty or entirely skipped suite, an invalid path, an oversized request, a missing or changed runtime, and a failed original test.

## Verify in a clean checkout

Use Node 24, 64-bit Windows with .NET Framework 4.x C# compiler, and 64-bit CPython 3.13.7. In PowerShell from the repository root:

```powershell
$env:XI_TRUSTED_PYTHON = (Get-Command python.exe -CommandType Application).Source
node xi-specific/companion/python-unittest/verify.mjs
```

If several interpreters are installed, set the variable to the absolute path of the matching executable. The verifier expects one successful original test and three rejected cases. Source for the native isolation process is already tracked at `../dsh/AppContainerRunner.cs`. Each run compiles that exact pinned source into a fresh temporary directory. Node, C# and the trusted packing helper run outside the container. Only the copied interpreter and selected test/source run inside it. The pinned combined digest covers the selected interpreter binaries and standard library archive; a different Python distribution can require a separate verified profile. This build has no pip installation step.

Call `runPythonProject({files,test,sandboxRoot,pythonExecutable,signal})` from `index.mjs`. `files` is a mapping of repository-relative names to text, including the original test. Only a trusted host should provide runtime and scratch paths. The host owns caller authentication, file-selection approval, output review and rollback. Resolve symbolic links and approve source material before constructing the mapping. The runner accepts up to 24 named files, each at most 32,000 UTF-8 bytes, with a 96,000-byte JSON aggregate limit.

This component supports an individual unittest module and approved root, src and package imports. The runtime includes selected standard-library extensions. Windows CPython 3.13 can create an ACL-protected 0700 temporary directory that the AppContainer itself cannot reopen, which affects tests that use TemporaryDirectory. Tests requiring external packages, another native interpreter or special host access need their own compatible runtime.
