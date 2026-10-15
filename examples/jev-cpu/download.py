from huggingface_hub import snapshot_download
from pathlib import Path

target = Path(__file__).parent / 'model'
snapshot_download('Qwen/Qwen3-0.6B', revision='c1899de289a04d12100db370d81485cdf75e47ca', local_dir=str(target), allow_patterns=['*.json', '*.safetensors', '*.txt', 'LICENSE'])
print('Downloaded pinned weights:', target)
