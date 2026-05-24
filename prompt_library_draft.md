# Grouped prompt node

> **Legacy (V1) draft.** Early design notes for the original JSON-file prompt
> library. Superseded by **Prompt Library V2** — see `README_Prompt_Library_V2.md`.

prompt_library is a custom node for Comfyui, the purpose is to allow users to create/edit/save danbooru prompts as entries in a library. The prompt_library node should also provide a textbox, in which the user can cite existing entries by name or by entry tags.

The prompt library entries should be saved in and loaded from a local folder \ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-XYZNodes\prompt_library as json files.

**An entry has the following properties:**

- name
- a boolean value to control whether the entry is active/inactive
- a boolean value to control whether tags in the entry should be shuffled or not before output.
- a weight *a* or a weight range *a-b* that applies to all prompts in the entry. *a,b* are decimal numbers between 0 and 5 with step size 0.1.
- an integer *i* or an integer range *i-j* that controls the random number of active prompt groups to output.
- a list of string tags
- a list of prompt groups. Each prompt group has the following properties:
  - name
  - a boolean value to control whether the group is active/inactive
  - a boolean value to control whether tags in the group should be shuffled or not at output stage.
  - a weight *a* or a weight range *a-b* that applies to all prompts in the group. *a,b* are decimal numbers between 0 and 5 with step size 0.1.
  - an integer *i* or an integer range *i-j* that controls the random number of active prompts to output.
  - a list of prompts. Each prompt has the following properties
    - the prompt context string
    - a boolean value to control whether the prompt is active/inactive
    - an order index
    - a prompt weight *a* or a weight range *a-b*. *a,b* are decimal numbers between 0 and 5 with step size 0.1.

The prompt output of each entry is determined by the following algorithms:

```
if entry.active == false: return ""
if entry.weight == "a-b":
  entry_weight = uniform random integer in range [a,b] at step size 0.1
else if entry.weitght == "a": 
  entry_weight = a
active_groups = [group in entry.groups if group.active == true]
if entry.random == "j-k":
  pick a random integer i between j,k
  active_groups = [i random distinct groups in active_groups] while keeping the same ordering as they are in the original list
else if entry.random == "i":
  active_groups = [i random distinct groups in active_groups] while keeping the same ordering as they are in the original list
if entry.shuffle:
  shuffle active_groups
group_outputs = []

for each group in active_groups:
  if group.active == false; pass
  if group.weight == "a-b":
    group_weight = uniform random integer in range [a,b] at step size 0.1
  else: 
    group_weight = a
  active_prompts = [prompt in group.prompts if prompt.active == true]
  if group.random == "j-k":
    pick a random integer i between j,k
    active_prompts = [i random distinct prompts in active_prompts] while keeping the same ordering as they are in the original list
  else if group.random == "i":
    active_prompts = [i random distinct prompts in active_prompts] while keeping the same ordering as they are in the original list
  if group.shuffle:
    shuffle active_prompts
  prompt_outputs = []

  for each prompt in active_prompts:
    if prompt.active == false: pass
    if prompt.weight == "a-b":
      prompt_weight = uniform random integer in range [a,b] at step size 0.1
    else: 
      prompt_weight = prompt.weight
    weight = entry_weight * group_weight * prompt_weight
    if weight == 1:
      prompt_outputs.append(prompt.context)
    else:
      prompt_outputs.append("$({prompt.context}:${weight})")
  # after collecting all active prompt outputs
  group_outputs.append(prompt_outputs.join(", "))

# after collecting all group prompt outputs
return group_outputs.join(",\n")
```

**The backend of the node has the following features.**

input:

- random seed:int
- multiline text box:string

output: string obtained by the following 2-step find and replace algorithm:

Step 1, find and replace the following patterns:

- "[[tag_name]possibly_more_text...]": replace "[tag_name]" by the name of a random active entry with tag tag_name

- "[[tag_name:i]possibly_more_text...]": make i copies of this pattern, replace "[tag_name]" by the name of i distinct random active entries with tag ${tag_name}
-
- "[[tag_name:j-k]possibly_more_text...]": first pick a random integer i in range [j,k]. Make i copies of this pattern, replace "[tag_name]" by the name of i distinct random active entries with tag ${tag_name}

Step 2, find and replace the following patterns:

- "[entry_name]": replace by the output of the entry with name entry_name if it exists in library
- "[entry_name/group_name]": replace by the output of the group group_name in the entry entry_name if it exists

**frontend description**

Node layout. Other than the inputs, widgets, outputs provided by the backend, then frontend should have the following features:

- a button to open a secondary floating window that shows the library entries

Library window layout.

Left of the window, from top to bottom:

- a one line text input for searching purpose
- a button to list all the entries that are being cited by the node multiline text box, including the entries that are matched by tags. A button to switch between search entry name mode and search entry tag mode. a button to apply search action. For search name mode, search for any entry name that contains the entered string as a substring. For search tag mode, only search for entries whose tags matches the entered string exactly.
- a scrollable list on entries, in alphabetic order their names. Each entry has a button to make the entry active/inactive, a delete button to delete the entry, and a name label. When the search text is empty. The list should show all entries in library. Clicking on an entry will show its detail information on the right.

Right of the window, from top to bottom:

- text input to edit the entry name. Save to library button to update all the changes being made to this entry to the json file in \ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-XYZNodes\prompt_library.
- a button to active/inactive the entry. This button should work in unison with the active button on the left side. Their states should always be the same. a button to control the shuffle property of the entry. text labels and inputs to show and edit the weight property and randomization property of the entry as defined above.
- a text input to show and edit the tags of this entry. The tags should be displayed in a string, separated by a comma and a space. After user edits the text input, update the entry tags by splitting the user input by comma and trimming whitespaces.
- Note: Changes made for entries should note be saved to library unless the save to library button is clicked. However, the changes should be applied to the replacing algorithm at the backend. And the changes should be preserved between restarts of backends and front ends.
- a button to create a new group
- a scrollable list of prompt groups

Each group should have the following feature
  
- active/inactive button, text input to show and edit name, delete group button, dropdown button, buttons to move the group 1 position up/down in the list of groups
- Clicking the dropdown button will should a container below the group. The container should not collapse unless the dropdown button is clicked again.
- In the dropdown container, one should have
  - text inputs to should and edit the group's weight and randomization properties as defined above, and a button to control the shuffle property
  - a button to control the display mode of the list of prompts, a button to create new prompts
  - detail mode: the prompts in the group is listed vertically. Each prompt item has
    - active button
    - order index output
    - context string input
    - weight input
    - delete button
  - simple mode: display a multiline textbox, which shows prompt_outputs.join(", ") as generated in the above algorithm.
    - After the user edits the multiline textbox and clicked some place outside the textbox, update the prompts by the following algorithm:
    - parse the textbox input, which should be of the format "prompt1, (prompt2:weight2), ..., (prompt_n, weight_n)"
    - make all the prompts listed in the textbox active, make all prompts not given in the textbox inactive, update the active prompts' weights. If there are prompts in the textbox that do not exists in this group yet, show a comfyui popup window to ask the user whether they want to create new prompts in the groups. Reorder the active prompts' order index according to their order in textbox
  - side by side mode: displays the detail mode and simple mode side by side. Changes in one display should immediately updates the other mode.

frontend details:

- every text input button should updates the data it represents after user edited it and then clicked somewhere outside.
- The frontend should have a nice looking design and nice color choice.
