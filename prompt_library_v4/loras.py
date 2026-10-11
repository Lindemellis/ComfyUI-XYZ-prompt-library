"""Independent, read-only model browser; editable triggers live in AssetLibrary.

No model weights are loaded and no model/third-party sidecars are written.
Filesystem/network work is called by the HTTP adapter in worker threads.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .model import CommandError

MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.pkl', '.sft'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'}


def remote_image(value):
    if not isinstance(value, str): return None
    parsed = urlparse(value)
    return value if parsed.scheme == 'https' and parsed.hostname in {'image.civitai.com', 'images.civitai.com', 'civitai.com'} and not parsed.username else None


def civitai_link(info):
    model, version = info.get('modelId'), info.get('id')
    if not isinstance(model, int) or isinstance(model, bool) or model <= 0: return None
    return f'https://civitai.red/models/{model}' + (f'?modelVersionId={version}' if isinstance(version, int) and not isinstance(version, bool) and version > 0 else '')


def read_json(path):
    try:
        if path.stat().st_size > 8 * 1024 * 1024: return {}
        value = json.loads(path.read_text(encoding='utf-8-sig'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, UnicodeError): return {}


class LoraBrowser:
    def __init__(self, roots, library, cache_dir, fetch_json=None, extensions=None):
        self.roots = roots  # Callable: configuration may change during a session.
        self.library = library
        self.cache_dir = Path(cache_dir)
        self.fetch_json = fetch_json or self._fetch_json
        self.extensions = extensions or (lambda: MODEL_EXTENSIONS)
        self._lock = threading.RLock()
        self._files = {}
        self._stamp = 0

    @staticmethod
    def _fetch_json(digest):
        request = Request(f'https://civitai.com/api/v1/model-versions/by-hash/{digest}', headers={'User-Agent': 'XYZNodes-LoRA-Browser', 'Accept': 'application/json'})
        with urlopen(request, timeout=25) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024: raise ValueError('Civitai 返回的资料过大')
        value = json.loads(data)
        if not isinstance(value, dict) or not isinstance(value.get('modelId'), int): raise ValueError('Civitai 未返回有效模型版本')
        return value

    def scan(self, force=False):
        with self._lock:
            roots = tuple(Path(root).resolve() for root in self.roots())
            extensions = frozenset(str(ext).lower() for ext in self.extensions())
            if not force and roots == getattr(self, '_roots', None) and extensions == getattr(self, '_extensions', None) and time.monotonic() - self._stamp < 5: return
            files, directories, occupied = {}, [], set()
            for root in dict.fromkeys(roots):
                root_id = hashlib.sha256(str(root).encode()).hexdigest()[:16]
                directories.append({'id': root_id, 'name': root.name, 'path': str(root), 'folders': []})
                if not root.is_dir(): continue
                folders = set()
                for base, dirs, names in os.walk(root, followlinks=False):
                    dirs[:] = sorted(d for d in dirs if not (Path(base) / d).is_symlink())
                    folder = Path(base).relative_to(root).as_posix()
                    if folder != '.': folders.add(folder)
                    for name in sorted(names):
                        path = Path(base) / name
                        if path.suffix.lower() not in extensions: continue
                        real = path.resolve()
                        if not real.is_relative_to(root) or not real.is_file(): continue
                        relative = path.relative_to(root).as_posix()
                        key = hashlib.sha256(f'{root}\0{relative}'.encode()).hexdigest()
                        path_key = os.path.normcase(relative)
                        files[key] = {'id': key, 'name': path.stem, 'relative': relative, 'folder': path.parent.relative_to(root).as_posix(), 'root_id': root_id, 'shadowed': path_key in occupied, '_path': real, '_root': root}
                        occupied.add(path_key)
                directories[-1]['folders'] = sorted({parent.as_posix() for folder in folders for parent in [Path(folder), *Path(folder).parents] if parent.as_posix() != '.'})
            self._roots, self._files, self._directories = roots, files, directories
            self._extensions = extensions
            self._stamp = time.monotonic()

    def file(self, key):
        self.scan()
        value = self._files.get(key)
        if not value: raise CommandError('missing_lora', 'LoRA 已移除，请刷新目录')
        path = value['_path']
        if not path.resolve().is_relative_to(value['_root']) or not path.is_file(): raise CommandError('missing_lora', 'LoRA 文件已移除或路径已变化')
        return value

    @staticmethod
    def fingerprint(file):
        stat = file['_path'].stat()
        return [stat.st_size, stat.st_mtime_ns]

    def metadata(self, file):
        path = file['_path']
        data = {}
        for suffix in ('.metadata.json', '.civitai.info'):
            candidate = path.with_suffix(suffix)
            if candidate.resolve().is_relative_to(file['_root']):
                data = read_json(candidate)
                if data: break
        if not data:
            candidate = Path(str(path) + '.civitai.info')
            if candidate.resolve().is_relative_to(file['_root']): data = read_json(candidate)
        cache = read_json(self.cache_dir / (file['id'] + '.json'))
        if cache.get('fingerprint') == self.fingerprint(file) and isinstance(cache.get('civitai'), dict):
            # Fetched data takes precedence over older sidecars, but never writes them.
            data = {**data, 'civitai': cache['civitai']}
        info = data.get('civitai') if isinstance(data.get('civitai'), dict) else data
        words = info.get('trainedWords', data.get('trigger_words', []))
        if isinstance(words, str): words = [words]
        words = list(dict.fromkeys(word.strip() for word in words if isinstance(word, str) and word.strip())) if isinstance(words, list) else []
        return data, info, words

    def images(self, file, data, info):
        path, root = file['_path'], file['_root']
        found = []
        cover = data.get('preview_url')
        if isinstance(cover, str) and (Path(cover).is_absolute() or not urlparse(cover).scheme):
            candidate = Path(cover)
            if not candidate.is_absolute(): candidate = path.parent / candidate
            if candidate.resolve().is_relative_to(root) and candidate.is_file() and candidate.suffix.lower() in IMAGE_EXTENSIONS: found.append(candidate.resolve())
        for candidate in sorted(path.parent.glob(path.stem + '.*'), key=lambda item: (not item.name.startswith(path.stem + '.preview.'), item.name.casefold())):
            if candidate.suffix.lower() in IMAGE_EXTENSIONS and candidate.resolve().is_relative_to(root) and candidate.is_file(): found.append(candidate.resolve())
        image_dir = path.parent / path.stem
        if image_dir.resolve().is_relative_to(root) and image_dir.is_dir():
            found.extend(candidate.resolve() for candidate in sorted(image_dir.iterdir()) if candidate.suffix.lower() in IMAGE_EXTENSIONS and candidate.resolve().is_relative_to(root) and candidate.is_file())
        found = list(dict.fromkeys(found))
        images = [{'url': f'/xyz/plv4/loras/image/{file["id"]}/{index}', 'local': True} for index in range(len(found))]
        urls = [cover, *(image.get('url') for image in info.get('images', []) if isinstance(image, dict))] if isinstance(info.get('images', []), list) else [cover]
        images.extend({'url': url, 'local': False} for url in dict.fromkeys(remote_image(url) for url in urls) if url)
        return images, found

    def describe(self, file):
        data, info, words = self.metadata(file)
        images, _ = self.images(file, data, info)
        return {k: value for k, value in file.items() if not k.startswith('_')} | {'images': images, 'triggers': words, 'civitai_url': civitai_link(info), 'base_model': info.get('baseModel', data.get('base_model', ''))}

    def complete(self, query='', limit=30):
        if not isinstance(query, str) or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise CommandError('invalid_request', '无效补全参数')
        self.scan()
        # Completion only reads the file index: no metadata, hashing or pool creation.
        rows = [file for file in self._files.values() if not file['shadowed'] and not any(char in file['relative'] for char in ':<>\r\n') and query.casefold() in file['relative'].casefold()]
        rows.sort(key=lambda file: (file['relative'].casefold(), file['root_id']))
        return {'items': [{key: file[key] for key in ('id', 'name', 'relative')} for file in rows[:limit]]}

    def list(self, query='', root_id=None, folder=None, offset=0, limit=60, refresh=False):
        if not isinstance(query, str) or not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100: raise CommandError('invalid_request', '无效浏览参数')
        self.scan(refresh)
        rows = [file for file in self._files.values() if (not root_id or file['root_id'] == root_id) and (folder is None or folder == '.' or file['folder'] == folder or file['folder'].startswith(folder + '/')) and query.casefold() in file['relative'].casefold()]
        rows.sort(key=lambda file: (file['relative'].casefold(), file['root_id']))
        return {'roots': self._directories, 'total': len(rows), 'items': [self.describe(file) for file in rows[offset:offset + limit]]}

    def detail(self, key, ensure=False, import_triggers=False):
        file = self.file(key)
        result = self.describe(file)
        if ensure:
            pool = self.library.mutate({'action': 'ensure_lora', 'lora': {k: result[k] for k in ('id', 'name', 'relative', 'root_id')}, 'triggers': result['triggers'], 'import_triggers': import_triggers})
            result['pool_id'] = pool['id']
        return result

    def send(self, key):
        file = self.file(key)
        if file['shadowed']: raise CommandError('ambiguous_lora', '相同相对路径在较优先的模型目录中存在；prompt-control 会加载那个文件，请先调整目录或文件名')
        # Colon and angle brackets cannot be represented in prompt-control's LoRA name.
        if any(char in file['relative'] for char in ':<>\r\n'): raise CommandError('invalid_lora_name', '文件名含 LoRA 调用不支持的字符，请重命名后刷新')
        return self.detail(key, ensure=True)

    def image(self, key, index):
        file = self.file(key)
        data, info, _ = self.metadata(file)
        _, paths = self.images(file, data, info)
        if index < 0 or index >= len(paths): raise CommandError('missing_image', '预览图片已移除')
        path = paths[index]
        if not path.resolve().is_relative_to(file['_root']): raise CommandError('missing_image', '预览路径已变化')
        return path

    def fetch(self, key):
        file = self.file(key)
        before = self.fingerprint(file)
        digest = hashlib.sha256()
        with file['_path'].open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''): digest.update(chunk)
        if before != self.fingerprint(file): raise CommandError('changed_lora', '模型文件在读取期间变化，请重试')
        try: info = self.fetch_json(digest.hexdigest())
        except Exception as error: raise CommandError('civitai_unavailable', f'Civitai 资料获取失败：{error}。仍可使用本地模型和手动编辑触发词。') from error
        if before != self.fingerprint(file): raise CommandError('changed_lora', '模型文件已变化，请重新获取资料')
        with self._lock:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            target = self.cache_dir / (key + '.json')
            temporary = target.with_suffix('.tmp')
            temporary.write_text(json.dumps({'fingerprint': before, 'civitai': info}, ensure_ascii=False), encoding='utf-8')
            os.replace(temporary, target)
        return self.detail(key)
