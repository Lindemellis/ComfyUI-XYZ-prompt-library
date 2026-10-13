"""Region timing (decisions 2026-10-13).

* A schedule on a region, or above it, decides whether the region EXISTS: outside
  the window there is no region syntax at all, only the ambient text.
* A schedule inside a region only times that content.
* A Region container has two windows on one slider: `schedule` (outside it the
  whole container is gone) and `region_window` (inside `schedule` but outside the
  window the entries merge into ordinary prompt text).
* No base and no fill: the area no region covers is drawn by the ambient text,
  never by prompt-control's empty full-image base.
"""
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.model import CommandError, EditorState


SOURCE = ('m, 2girls, [@region]: { [mask: [0, 0.5, 0, 1]]: { stelle } '
          '[mask: [0.5, 1, 0, 1]]: { kafka } }')
SPLIT = 'COUPLE MASK(0 0.5, 0 1, 1) m, 2girls, stelle\nCOUPLE MASK(0.5 1, 0 1, 1) m, 2girls, kafka'


def command(state, kind, **body):
    return apply_command(state, dict(type=kind, revision=state.revision, **body))


def container(state):
    return next(n for n in state.doc.root.walk() if n.form == 'region')


def test_both_windows_are_settings_of_the_region_container():
    state = EditorState.create(SOURCE)
    state = command(state, 'SetSettings', id=container(state).id,
                    patch={'schedule': [0, 0.8], 'region_window': [0, 0.4]})
    assert '.set{schedule: {0, 0.8}, region_window: {0, 0.4}}' in state.text
    prompt = compile_document(state, seed=1, region_mode='couple')['prompt']
    assert prompt == (f'[FILL() m, 2girls\n{SPLIT}, :0,0.4] '
                      '[m, 2girls, stelle, kafka, :0.4,0.8] [m, 2girls, :0.8,1]')
    # moving the inner handles back onto the outer ones removes the field again
    state = command(state, 'SetSettings', id=container(state).id, patch={'region_window': None})
    assert 'region_window' not in state.text


def test_region_window_is_refused_on_anything_but_a_region_container():
    state = EditorState.create('a, { b }')
    block = next(n for n in state.doc.root.walk() if n.kind == 'group' and n is not state.doc.root)
    with pytest.raises(CommandError):
        command(state, 'SetSettings', id=block.id, patch={'region_window': [0, 0.4]})


@pytest.mark.parametrize('mode', ['couple', 'mask'])
def test_a_disabled_region_container_ignores_its_region_window(mode):
    state = EditorState.create(SOURCE + '.set{region_window: {0, 0.4}}')
    state = command(state, 'SetRegionEnabled', id=container(state).id, enabled=False)
    assert compile_document(state, seed=1, region_mode=mode)['prompt'] == 'm, 2girls, stelle, kafka'


def test_plain_output_ignores_region_timing():
    state = EditorState.create(SOURCE + '.set{region_window: {0, 0.4}}')
    assert compile_document(state, seed=1, region_mode='couple')['plain'] == 'm, 2girls, stelle, kafka'
