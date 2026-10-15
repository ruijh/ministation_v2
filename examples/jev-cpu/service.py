"""Offline CPU decision service; SemIf option-logit readout, no text generation."""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'vendor' / 'src'))
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from semif_phase1.direct import score, encode_prompt
from semif_phase1.core import validate_row

MODEL_PATH = os.environ.get('MODEL_PATH', '/models/qwen3-0.6b')
MAX_TOKENS = int(os.environ.get('MAX_INPUT_TOKENS', '1024'))
torch.set_num_threads(int(os.environ.get('CPU_THREADS', '2')))
torch.set_num_interop_threads(1)
tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True, trust_remote_code=False)
model = AutoModelForCausalLM.from_pretrained(MODEL_PATH, local_files_only=True, trust_remote_code=False, dtype=torch.float32).eval()
metadata = {'source': 'Qwen/Qwen3-0.6B', 'revision': 'c1899de289a04d12100db370d81485cdf75e47ca', 'device': 'cpu', 'dtype': 'float32'}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == '/api/health':
            self.reply(200, {'ready': True, **metadata, 'max_input_tokens': MAX_TOKENS})
        else:
            self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/api/decide':
            return self.reply(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 131072:
                return self.reply(413, {'error': 'request too large or empty'})
            body = json.loads(self.rfile.read(length))
            if body.get('model', metadata['source']) != metadata['source']:
                raise ValueError('unknown model')
            criteria = body['criteria']
            if not isinstance(criteria, list) or not 1 <= len(criteria) <= 8:
                raise ValueError('criteria must contain 1-8 questions')
            rows = [dict(c, state=body['state']) for c in criteria]
            for row in rows:
                validate_row(row)
            if len({r['id'] for r in rows}) != len(rows):
                raise ValueError('duplicate criterion id')
        except (ValueError, TypeError, KeyError):
            return self.reply(422, {'error': 'invalid decision request'})
        if not lock.acquire(blocking=False):
            return self.reply(429, {'error': 'CPU engine busy; retry later'})
        try:
            # Validate every prompt before starting any inference.
            for row in rows:
                encode_prompt(tokenizer, row, MAX_TOKENS)
            started = time.perf_counter()
            results = []
            for row in rows:
                value = score(model, tokenizer, row, metadata, max_tokens=MAX_TOKENS)
                ranked = sorted([{'id': i, 'prob': p} for i, p in zip(value['option_ids'], value['probabilities'])], key=lambda p: -p['prob'])
                results.append({'id': row['id'], 'winner': ranked[0]['id'], 'ranked': ranked, 'input_tokens': value['input_tokens'], 'forward_seconds': value['forward_seconds'], 'error': None})
            self.reply(200, {'results': results, 'model': metadata['source'], 'revision': metadata['revision'], 'total_seconds': time.perf_counter() - started})
        except ValueError:
            self.reply(422, {'error': 'prompt exceeds token limit or invalid option encoding'})
        except Exception as exc:
            print(type(exc).__name__, flush=True)
            self.reply(500, {'error': 'inference failed'})
        finally:
            lock.release()

    def log_message(self, *_args):
        pass


if __name__ == '__main__':
    print('CPU decision engine ready', metadata, flush=True)
    ThreadingHTTPServer((os.environ.get('BIND_HOST', '127.0.0.1'), int(os.environ.get('PORT', '8801'))), Handler).serve_forever()
