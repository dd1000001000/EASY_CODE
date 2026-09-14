import asyncio
import multiprocessing as mp
import socket
import subprocess
import sys
from multiprocessing import shared_memory

def test_temp(tmp_path):
    (tmp_path / '中文.txt').write_text('ok', encoding='utf-8')

def test_child():
    assert subprocess.check_output([sys.executable, '-c', 'print(42)']).strip() == b'42'

def test_asyncio():
    async def value():
        return 42
    assert asyncio.run(value()) == 42

def test_semaphore_shared_memory():
    s=mp.Semaphore(1)
    assert s.acquire(timeout=1)
    s.release()
    m=shared_memory.SharedMemory(create=True,size=8)
    try:
        m.buf[0]=42
        assert m.buf[0]==42
    finally:
        m.close()
        m.unlink()

def test_socketpair():
    a,b=socket.socketpair()
    try:
        a.send(b'x')
        assert b.recv(1)==b'x'
    finally:
        a.close()
        b.close()
