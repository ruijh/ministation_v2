$ErrorActionPreference = 'Stop'
$modelDir = Join-Path $PSScriptRoot 'model'
New-Item -ItemType Directory -Force $modelDir | Out-Null
$revision = 'c1899de289a04d12100db370d81485cdf75e47ca'
foreach ($file in @('config.json','generation_config.json','merges.txt','tokenizer.json','tokenizer_config.json','vocab.json','LICENSE')) {
    if (!(Test-Path (Join-Path $modelDir $file))) {
        Invoke-WebRequest "https://huggingface.co/Qwen/Qwen3-0.6B/resolve/$revision/$file" -OutFile (Join-Path $modelDir $file)
    }
}
node (Join-Path $PSScriptRoot 'download-weights.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Weight download or checksum failed' }
