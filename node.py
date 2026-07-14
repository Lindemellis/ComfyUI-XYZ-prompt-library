"""Shared node helpers.

All that survives here is `ByPassTypeTuple`, the trick that lets a node declare a
VARIADIC number of outputs: RETURN_TYPES is a tuple whose __getitem__ clamps every
index to 0, so ComfyUI validates any slot against the single declared type while
the frontend adds the real slots. Used by `XYZ Mask Editor` and
`XYZ Krita Fetch Color Masks`.

(The standalone utility nodes that used to live here, and the legacy V1 Prompt
Library that used to own this helper, are both gone.)
"""


class TautologyStr(str):
	def __ne__(self, other):
		return False


class ByPassTypeTuple(tuple):
	def __getitem__(self, index):
		if index > 0:
			index = 0
		item = super().__getitem__(index)
		if isinstance(item, str):
			return TautologyStr(item)
		return item
