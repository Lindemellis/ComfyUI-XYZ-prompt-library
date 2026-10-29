"""Conservative output-only sentence casing; never lowercases existing letters."""
import re

_TOKEN = re.compile(r'https?://\S+|<[^>]+>|\b[\w.+-]+@[\w.-]+\b|\S+')
_ABBREVIATIONS = {'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e'}


def sentence_case(text):
    chars = list(text)
    start = True
    protected = set()
    for match in _TOKEN.finditer(text):
        token = match.group()
        if token.startswith(('http:', 'https:', '<', '@')) or '_' in token or '@' in token or re.match(r'[a-z]+[A-Z]', token):
            protected.update(range(match.start(), match.start() + len(token.rstrip('.!?。！？'))))
    for i, char in enumerate(text):
        if i in protected:
            if not char.isspace(): start = False
            continue
        if start:
            if 'a' <= char <= 'z':
                chars[i] = char.upper(); start = False
            elif char.isalnum():
                start = False
        if char in '.!?。！？':
            # A period within a token (decimal, URL, dotted name) is not a boundary.
            j = i + 1
            while j < len(text) and text[j] in '\"\'”’)]': j += 1
            if char in '.!?' and j < len(text) and not text[j].isspace(): continue
            word = re.search(r'([\w.]+)$', text[:i])
            word = word.group(1).lower() if word else ''
            if char == '.' and (word in _ABBREVIATIONS or (len(word) == 1 and word.isalpha()) or re.fullmatch(r'(?:[a-z]\.)+[a-z]?', word)):
                continue
            start = True
    return ''.join(chars)
