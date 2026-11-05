# Executed ONLY inside isolate. Python is necessary to run submitted Python functions;
# all services and sandbox orchestration are written in Rust.
import contextlib
import importlib.util
import io
import json
import sys
import traceback


def normalize(v):
    try:
        import numpy as np
        if isinstance(v, np.ndarray):
            return normalize(v.tolist())
        if isinstance(v, np.generic):
            return normalize(v.item())
    except ImportError:
        pass
    try:
        torch = sys.modules.get("torch")
        if torch is not None and isinstance(v, torch.Tensor):
            return normalize(v.detach().cpu().tolist())
    except ImportError:
        pass
    if isinstance(v, dict):
        return {str(k): normalize(val) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        return [normalize(x) for x in v]
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return repr(v)


def main():
    with open('/workspace/input.json', encoding='utf-8') as f:
        request = json.load(f)
    results = []
    namespace = {'__name__': '__submission__'}
    try:
        with open('/workspace/submission.py', encoding='utf-8') as f:
            source = f.read()
        exec(compile(source, 'submission.py', 'exec'), namespace)
        if request.get('class_name'):
            target = namespace[request['class_name']]()
            fn = getattr(target, request['function'])
        else:
            fn = namespace[request['function']]
        for i, case in enumerate(request['tests']):
            captured = io.StringIO()
            try:
                with contextlib.redirect_stdout(captured):
                    actual = normalize(fn(*case.get('args', []), **case.get('kwargs', {})))
                results.append({'index': i, 'actual': actual, 'stdout': captured.getvalue()[:4096]})
            except BaseException:
                results.append({'index': i, 'error': traceback.format_exc(limit=8)[-4000:], 'stdout': captured.getvalue()[:4096]})
    except BaseException:
        results.append({'index': 0, 'error': traceback.format_exc(limit=8)[-4000:]})
    with open('/workspace/result.json', 'w', encoding='utf-8') as f:
        json.dump(results, f, allow_nan=False)


if __name__ == '__main__':
    main()
