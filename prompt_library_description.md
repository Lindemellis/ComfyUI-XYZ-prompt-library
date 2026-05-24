# Prompt Library Custom Node - Technical Requirements Specification

> **Legacy (V1) spec.** Describes the original JSON-file prompt library.
> Superseded by **Prompt Library V2** — see `README_Prompt_Library_V2.md`.

## 1. Overview

The Prompt Library is a custom node for ComfyUI that enables users to create, edit, save, and manage Danbooru-style prompts as organized library entries. The node provides a textbox interface where users can reference existing entries by name or tags, with a comprehensive backend algorithm for prompt generation and a feature-rich frontend for library management.

## 2. System Architecture

### 2.1 Data Storage

- **Storage Location**: `\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-XYZNodes\prompt_library`
- **Format**: JSON files for each library entry
- **Persistence**: Changes are saved to disk only when explicitly requested via "Save to Library" button

### 2.2 Data Persistence Strategy

- **Temporary Storage**: Unsaved changes are stored in browser localStorage using node-specific keys
- **Session Persistence**: Changes persist across browser sessions and ComfyUI restarts until explicitly saved
- **Storage Key Format**: `prompt_library_${node_id}_${entry_name}` for individual entry data
- **Fallback Mechanism**: If localStorage is unavailable, changes are stored in memory only

### 2.3 Data Model

#### 2.3.1 Entry Properties

- **name**: String identifier for the entry
- **active**: Boolean controlling entry activation state
- **shuffle**: Boolean controlling whether tags should be shuffled before output
- **weight**: Decimal value or range (0.0 to 5.0, step size 0.1)
  - Single value: `a` (e.g., 1.5)
  - Range: `a-b` (e.g., 1.0-2.5) - **inclusive range [a,b]**
- **random**: Integer or range controlling number of active prompt groups to output
  - Single value: `i` (e.g., 3)
  - Range: `i-j` (e.g., 2-5) - **inclusive range [i,j]**
- **tags**: List of string tags for categorization
- **groups**: List of prompt groups

#### 2.3.2 Group Properties

- **name**: String identifier for the group
- **active**: Boolean controlling group activation state
- **shuffle**: Boolean controlling whether prompts should be shuffled before output
- **weight**: Decimal value or range (0.0 to 5.0, step size 0.1)
- **random**: Integer or range controlling number of active prompts to output
- **prompts**: List of individual prompts

#### 2.3.3 Prompt Properties

- **context**: String containing the prompt text
- **active**: Boolean controlling prompt activation state
- **order_index**: Integer defining prompt sequence order
- **weight**: Decimal value or range (0.0 to 5.0, step size 0.1)

## 3. Backend Algorithm

### 3.1 Entry Processing Algorithm

```
if entry.active == false: return ""
if entry.weight == "a-b":
  entry_weight = uniform random value in range [a,b] at step size 0.1
else if entry.weight == "a": 
  entry_weight = a

active_groups = [group in entry.groups if group.active == true]

if entry.random == "j-k":
  pick a random integer i between j,k (inclusive)
  active_groups = [i random distinct groups in active_groups] while preserving original ordering
else if entry.random == "i":
  active_groups = [i random distinct groups in active_groups] while preserving original ordering

if entry.shuffle:
  shuffle active_groups

group_outputs = []
```

### 3.2 Group Processing Algorithm

```
for each group in active_groups:
  if group.active == false: continue
  
  if group.weight == "a-b":
    group_weight = uniform random value in range [a,b] at step size 0.1
  else: 
    group_weight = group.weight
    
  active_prompts = [prompt in group.prompts if prompt.active == true]
  
  if group.random == "j-k":
    pick a random integer i between j,k (inclusive)
    active_prompts = [i random distinct prompts in active_prompts] while preserving original ordering
  else if group.random == "i":
    active_prompts = [i random distinct prompts in active_prompts] while preserving original ordering
    
  if group.shuffle:
    shuffle active_prompts
    
  prompt_outputs = []
```

### 3.3 Prompt Processing Algorithm

```
  for each prompt in active_prompts:
    if prompt.active == false: continue
    
    if prompt.weight == "a-b":
      prompt_weight = uniform random value in range [a,b] at step size 0.1
    else: 
      prompt_weight = prompt.weight
      
    final_weight = entry_weight * group_weight * prompt_weight
    
    if final_weight == 1.0:
      prompt_outputs.append(prompt.context)
    else:
      prompt_outputs.append("(${prompt.context}:${final_weight})")
      
  group_outputs.append(prompt_outputs.join(", "))

return group_outputs.join(",\n")
```

## 4. Text Processing Engine

### 4.1 Input Parameters

- **seed**: Integer for reproducible randomization
- **prompt_template**: String containing prompt references

### 4.2 Three-Step Processing Algorithm

#### Step 1: Pattern Recognition and Output Generation

- **Pattern**: `{string1|string2|...|string_n}`
- **Processing Order**: This step occurs **before** prompt library processing
- **Output Generation**:
  - If the node has `m` outputs, generate `m` variations
  - For each output position `i` (1 ≤ i ≤ m):
    - If `i` ≤ `n`, use `string_i` from the pattern
    - If `i` > `n`, use empty string `""`
- **Example**: Text "hello {a|b} world {x|y|z}" with 3 outputs produces:
  - Output 1: "hello a world x"
  - Output 2: "hello b world y"
  - Output 3: "hello [empty] world z"
- **Nested Syntax**: `{}` patterns can contain prompt library syntax like `[entry_name]`

#### Step 2: Tag-Based Entry Resolution

- **Pattern**: `[[${tag_name}]${possibly_more_text...}]`
  - **Action**: Replace `[${tag_name}]` with name of random active entry containing tag `${tag_name}`
- **Pattern**: `[[${tag_name}:i]${possibly_more_text...}]`
  - **Action**: Create `i` copies, replace with `i` distinct random active entries containing tag `${tag_name}`
- **Pattern**: `[[${tag_name}:j-k]${possibly_more_text...}]`
  - **Action**: Pick random integer `i` in range [j,k] (inclusive), create `i` copies with distinct entries

#### Step 3: Entry and Group Resolution

- **Pattern**: `[${entry_name}]`
  - **Action**: Replace with output of entry `${entry_name}`
- **Pattern**: `[${entry_name}/${group_name}]`
  - **Action**: Replace with output of group `${group_name}` from entry `${entry_name}`not allowed)

## 5. Frontend Interface

### 5.1 Main Node Interface

- **Input Widgets**: seed, prompt_template
- **Dynamic Outputs**:
  - **Add Output Button**: Adds new output using `addOutput()` method
  - **Remove Output Button**: Removes last output using `removeOutput()` method
  - **Output Count Display**: Shows current number of outputs
- **Output**: Multiple generated prompt strings (one per output)
- **Library Button**: Opens secondary floating window for library management

### 5.2 Library Management Window

#### 5.2.1 Left Panel

- **Search Input**: Single-line text input for search functionality
- **Search Controls**:
  - Button to list all cited entries (by name or tag matching)
  - Toggle between "Search by Entry Name" and "Search by Entry Tag" modes
  - Apply search button
- **Entry List**: Scrollable list of entries in alphabetical order
  - Each entry displays: active/inactive toggle, delete button, name label
  - Clicking an entry displays details in right panel
  - Search results filter the displayed entries
- **Save All Changes Button**:
  - **Function**: Saves all unsaved changes across all entries to disk at once
  - **Behavior**: Processes all modified entries and writes them to their respective JSON files
  - **User Feedback**: Shows progress indicator and success/error messages

#### 5.2.2 Right Panel - Entry Details

- **Entry Properties**:
  - Name input field with save button
  - Active/inactive toggle (synchronized with left panel)
  - Shuffle control toggle
  - Weight input (single value or range)
  - Randomization input (single value or range)
- **Tags Management**:
  - Comma-separated text input
  - Auto-split by comma and trim whitespace on edit
  - **Search Behavior**: Search string must match one of the entry's tags exactly (not substring)
- **Group Management**:
  - Create new group button
  - Scrollable list of prompt groups

#### 5.2.3 Group Interface

- **Group Header**:
  - Active/inactive toggle
  - Name input field
  - Delete button
  - Dropdown expand/collapse button
  - Move up/down buttons
- **Group Details** (in dropdown):
  - Weight and randomization properties
  - Shuffle control toggle
  - Display mode selector (detail/simple/side-by-side)
  - Create new prompt button

#### 5.2.4 Prompt Display Modes

##### Detail Mode

- Vertical list of prompts
- Each prompt shows: active toggle, order index, context input, weight input, delete button

##### Simple Mode

- Multiline textbox showing `prompt_outputs.join(", ")`
- **Parsing Algorithm**: Parse input format "prompt1, (prompt2:weight2), ..., (prompt_n:weight_n)"
- **Default Weight**: Prompts without explicit weights use default weight of 1.0
- **Update Behavior**:
  - Activate all prompts listed in textbox
  - Deactivate prompts not in textbox
  - Update weights for active prompts
  - Reorder by textbox sequence
  - Prompt creation dialog for new prompts

##### Side-by-Side Mode

- Detail and simple modes displayed simultaneously
- Bidirectional synchronization of changes

### 5.3 Frontend Behavior Specifications

- **Auto-save**: Text inputs update data on focus loss (clicking outside)
- **Data Persistence**: Changes preserved across sessions but not saved to library until explicit save
- **UI Design**: Professional appearance with appropriate color scheme and visual hierarchy

## 6. Technical Requirements

### 6.1 Data Validation

- Weight values: 0.0 to 5.0, step size 0.1
- Random values: Positive integers
- Name uniqueness: Entry and group names must be unique within their scope

### 6.2 Error Handling

- Graceful handling of missing entries/groups
- Validation of input formats
- User confirmation for destructive operations (deletion, prompt creation)

### 6.3 Performance Considerations

- Efficient JSON parsing and serialization
- Responsive UI updates
- Memory management for large prompt libraries

## 7. Implementation Notes

### 7.1 State Management

- **Temporary Storage**: Changes stored in localStorage with node-specific keys
- **Session Persistence**: Data survives browser restarts and ComfyUI restarts
- **Synchronization**: Real-time sync between main node and library window
- **Persistent Storage**: Only saved to disk on explicit "Save to Library" button click

### 7.2 Data Persistence Implementation

- **localStorage Keys**: `prompt_library_${node_id}_${entry_name}` for entry data
- **Fallback Strategy**: Memory-only storage if localStorage unavailable
- **Data Recovery**: Automatic restoration of unsaved changes on node initialization
- **Conflict Resolution**: User prompt when localStorage data conflicts with disk data

### 7.3 Prompt Creation Defaults

- **New Prompts from Button**:
  - Default weight: 1.0
  - Default active state: true
  - Default context: empty string
  - Order index: 1 + maximum index in current group
- **New Prompts from Textbox**:
  - Default weight: 1.0 (if not specified)
  - Default active state: true
  - Context: parsed from textbox input

### 7.4 Dynamic Output Management

- **Output Addition**: Uses ComfyUI's `addOutput()` method to dynamically add new outputs
- **Output Removal**: Uses ComfyUI's `removeOutput()` method to remove outputs
- **Output Synchronization**: All outputs maintain consistent prompt library processing
- **UI Updates**: Node interface automatically adjusts to reflect current output count

### 7.5 Pattern Recognition Implementation

- **Processing Order**: Pattern recognition occurs before prompt library processing
- **Output Generation**: Each output receives a unique variation based on available pattern options
- **Empty String Handling**: Missing pattern options are replaced with empty strings
- **Nested Syntax Support**: `{}` patterns can contain prompt library syntax for complex combinations

### 7.6 User Experience

- Intuitive workflow for prompt management
- Clear visual feedback for active/inactive states
- Efficient search and filtering capabilities
- Responsive interface for large prompt collections
- Seamless data persistence across sessions
- Dynamic output management with clear visual feedback
- Batch save functionality for efficient library management
