"""Shared node helpers.

The standalone utility nodes that used to live here (Multi Text Concatenate /
Replace, Multi Clip Encoder, Random String Picker) were removed. Only the type
helpers remain — `ByPassTypeTuple` is still used by the legacy V1 Prompt Library
node (prompt_library_node.py) for its variadic outputs.
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
