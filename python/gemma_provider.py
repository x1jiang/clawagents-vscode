"""Gemma agentic GGUF deployment defaults for the named profile picker."""
import os

GEMMA_MODEL = 'gemma4-agentic-v2'
GEMMA_BASE_URL = 'http://127.0.0.1:18080/v1'
GEMMA_PROFILE = 'profile:gemma-agentic'


def gemma_model():
    return (os.getenv('GEMMA_AGENTIC_MODEL') or GEMMA_MODEL).strip()


def gemma_base_url():
    return (os.getenv('GEMMA_AGENTIC_BASE_URL') or GEMMA_BASE_URL).strip().rstrip('/')


def is_gemma_model(model):
    value=str(model or '').strip().lower()
    return value==gemma_model().lower() or any(n in value for n in ('gemma4-agentic-v2','gemma4-v2-','gemma-4-12b-agentic-fable5-composer2.5-v2'))
