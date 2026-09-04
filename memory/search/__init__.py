"""Read-only Document Chunk search and offline FTS5 maintenance."""

from .chunk_query import get_document_chunk, search_document_chunks
from .fts_state import validate_fts_index

__all__ = ["search_document_chunks", "get_document_chunk", "validate_fts_index"]
