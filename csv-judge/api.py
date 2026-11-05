import hmac
import os
import tempfile
from pathlib import Path
from fastapi import FastAPI, Request, HTTPException
from csv_judge.judge import judge_submission

app=FastAPI(title='CSV Judge Internal Service',docs_url=None,redoc_url=None)
PROBLEMS=Path(__file__).parent/'problems'
DYNAMIC=Path(os.getenv('CSV_DYNAMIC_PROBLEMS','/data/csv-problems'))
import re

@app.get('/health')
def health(): return {'status':'ok'}

@app.post('/grade/{slug}')
async def grade(slug:str,request:Request):
    key=os.getenv('CSV_INTERNAL_KEY','')
    if not key or not hmac.compare_digest(request.headers.get('X-Internal-Key',''),key):
        raise HTTPException(403,'Forbidden')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',slug):
        raise HTTPException(404,'Unknown problem')
    problem=(DYNAMIC/slug) if (DYNAMIC/slug/'config.json').is_file() else (PROBLEMS/slug)
    if not (problem/'config.json').is_file():
        raise HTTPException(404,'Unknown problem')
    if int(request.headers.get('content-length','0') or '0')>10*1024*1024:
        raise HTTPException(413,'File too large')
    data=await request.body()
    if not data or len(data)>10*1024*1024: raise HTTPException(413,'Invalid file size')
    with tempfile.TemporaryDirectory() as tmp:
        dest=Path(tmp)/'submission.csv'
        dest.write_bytes(data)
        return judge_submission(problem,dest).to_dict()
