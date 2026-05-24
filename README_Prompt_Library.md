# ComfyUI-XYZNodes Prompt Library System

> **Legacy (V1).** This describes the original JSON-file prompt library
> (`prompt_library_node.py` / `prompt_library_window.js`). Superseded by
> **Prompt Library V2** — see `README_Prompt_Library_V2.md`.

## Overview

The Prompt Library System is a comprehensive prompt management solution for ComfyUI that provides hierarchical organization, advanced random selection algorithms, and real-time synchronization between the frontend interface and backend processing nodes.

## Architecture

The system consists of four main components:

1. **Frontend Library Window** (`prompt_library_window.js`) - User interface for managing prompt libraries
2. **Frontend Node Interface** (`prompt_library_node.js`) - ComfyUI node widget management
3. **Backend Processing Node** (`prompt_library_node.py`) - Python backend for prompt processing
4. **API Routes** (`__init__.py`) - HTTP endpoints for disk storage operations

## Data Flow Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Disk Storage  │◄──►│  Frontend Cache  │◄──►│  Node Widgets   │
│   (JSON Files)  │    │ (localStorage)   │    │ (Hidden Data)   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │  Library Window  │
                       │   (User UI)      │
                       └──────────────────┘
```

### Storage Workflow

1. **Disk Storage**: JSON files in `@prompt_library/` folder
2. **Browser Cache**: Modified/new entries stored in `localStorage`
3. **Widget Storage**: Hidden widgets in ComfyUI nodes for backend access
4. **Frontend State**: In-memory data structure with modification tracking

## Frontend Features

### 1. Library Window Interface

#### Entry Management
- **Create New Entry**: Automatically creates a group and empty prompt
- **Entry Properties**: Name, shuffle, weight, random count, tags
- **Active/Inactive Toggle**: Enable/disable entries without deletion
- **Save/Undo System**: Track modifications with save and revert options

#### Group Management
- **Hierarchical Organization**: Entries contain groups, groups contain prompts
- **Group Properties**: Name, active state, shuffle, weight, random count
- **Display Modes**: Detail, Simple, and Side-by-Side views
- **Auto-expansion**: New groups automatically expand to show content

#### Prompt Management
- **Order Control**: Custom order indices with automatic reordering
- **Weight System**: Individual prompt weights with range support
- **Batch Creation**: Parse text input to create multiple prompts
- **Active/Inactive Control**: Toggle individual prompts

### 2. Advanced Random Selection Algorithm

#### Syntax Overview
The random field supports a sophisticated syntax for controlling both active and inactive items:

```
Format: [active_part]:[inactive_part]

Examples:
""        → All active items, no inactive items
"3"       → 3 random active items, no inactive items  
"1-3"     → 1-3 random active items, no inactive items
":2"      → All active items, 2 random inactive items
"2:1-3"   → 2 random active items, 1-3 random inactive items
"1.0-2.0:1.1-1.3" → Range weights for both active and inactive
```

#### Order Preservation
- **Shuffle = false**: Randomly sampled items maintain their original order
- **Shuffle = true**: Randomly sampled items are shuffled
- **Active Items**: Order preserved using `order_index` for prompts, array index for groups
- **Inactive Items**: Always shuffled regardless of shuffle setting

### 3. Display Modes

#### Detail Mode
- Individual prompt controls for each prompt
- Order index editing
- Weight and active state toggles
- Full prompt context editing

#### Simple Mode
- Textarea for bulk prompt input
- Format: `prompt1, (prompt2:weight2), prompt3`
- Automatic parsing and prompt creation
- Batch confirmation for >10 new prompts

#### Side-by-Side Mode
- Both Detail and Simple modes visible simultaneously
- Real-time synchronization between views
- Changes in one view reflect in the other

### 4. User Interface Features

#### Search and Filtering
- **Text Search**: Search by entry name or tags
- **Cited Filter**: Show only entries referenced in prompt templates
- **Sorting**: By name, creation date, or last edit date

#### Visual Feedback
- **Selection Highlighting**: Current entry highlighted with golden border
- **Modification Indicators**: Save/undo buttons for modified entries
- **Expansion States**: Remember which groups are expanded/collapsed
- **Responsive Design**: Resizable window with proper scrolling

## Backend Processing Features

### 1. Three-Step Processing Algorithm

#### Step 1: Pattern Recognition
Processes `{option1|option2|option3}` patterns for output generation:
```
Template: "A {cat|dog|bird} in the {garden|park|forest}"
Output 1: "A cat in the garden"
Output 2: "A dog in the park"  
Output 3: "A bird in the forest"
```

#### Step 2: Tag Resolution
Processes `[[tag_name]]` patterns for tag-based entry selection:
```
Template: "[[nature]]"
Available: Entry "Outdoors" with tag "nature"
Result: "[Outdoors]"
```

#### Step 3: Entry Resolution
Processes `[entry_name]` and `[entry_name/group_name]` references:
```
Template: "[Outdoors/Animals]"
Result: Resolved content from "Animals" group in "Outdoors" entry
```

### 2. Advanced Random Selection

#### Active/Inactive Control
- **Active Items**: Items marked as active in the library
- **Inactive Items**: Items marked as inactive but can be included
- **Colon Syntax**: Separate control for active and inactive items
- **Weight Ranges**: Support for dynamic weight ranges (e.g., "1.0-2.0")

#### Order Preservation Logic
```python
if not group.get("shuffle", False):
    # Preserve original order
    active_prompts.sort(key=lambda p: p.get("order_index", 0))
    indices = random.sample(range(len(active_prompts)), count)
    indices.sort()  # Sort indices to preserve order
    active_prompts = [active_prompts[i] for i in indices]
else:
    # Shuffle randomly
    active_prompts = random.sample(active_prompts, count)
```

### 3. Weight Calculation System

#### Hierarchical Weight Multiplication
```
Final Weight = Entry Weight × Group Weight × Prompt Weight
```

#### Dynamic Weight Ranges
- **Static**: "1.5" → 1.5
- **Range**: "1.0-2.0" → Random value between 1.0 and 2.0
- **Step Size**: 0.1 increments for precise control
- **Fallback**: Invalid inputs default to 1.0

## Syntax Patterns

### 1. Output Generation Patterns

#### Basic Alternation
```
{option1|option2|option3}
```
- Generates different content for each output
- Supports unlimited options
- Empty string for missing options

### 2. Tag-Based Selection

#### Simple Tag Reference
```
[[tag_name]]
```
- Finds entries with matching tag
- Randomly selects from matching entries
- Supports count specification: `[[tag_name:3]]`

#### Tag with Count Range
```
[[tag_name:2-5]]
```
- Selects 2-5 random entries with matching tag
- Useful for variety in prompt generation

### 3. Entry and Group References

#### Full Entry Reference
```
[entry_name]
```
- Includes all active groups from the entry
- Applies entry-level random selection and shuffle
- Uses entry-level weights and settings

#### Group-Specific Reference
```
[entry_name/group_name]
```
- References specific group within an entry
- Applies group-level random selection and shuffle
- Uses group-level weights and settings
  
## Storage and Synchronization

### 1. Disk Storage

#### File Structure
```
@prompt_library/
├── entry_name_1.json
├── entry_name_2.json
└── entry_name_3.json
```

#### JSON Schema
```json
{
  "id": "unique_entry_id",
  "name": "Entry Name",
  "active": true,
  "shuffle": false,
  "weight": "1",
  "random": "",
  "tags": ["tag1", "tag2"],
  "groups": [
    {
      "name": "Group Name",
      "active": true,
      "shuffle": false,
      "weight": "1",
      "random": "",
      "displayMode": "detail",
      "prompts": [
        {
          "context": "Prompt text",
          "active": true,
          "order_index": 1,
          "weight": "1"
        }
      ]
    }
  ],
  "expansionStates": {
    "Group Name": true
  },
  "createDate": "2024-01-01T00:00:00.000Z",
  "lastEdit": "2024-01-01T00:00:00.000Z"
}
```

### 2. Browser Cache

#### localStorage Keys
```
prompt_library_[entry_id] = JSON.stringify(entry_data)
```

#### Cache Management
- **Modified Entries**: Stored with modification flags
- **New Entries**: Stored as temporary until saved to disk
- **Auto-sync**: Automatic synchronization with node widgets
- **Conflict Resolution**: Frontend data takes precedence

### 3. Widget Synchronization

#### Hidden Widgets
- **library_data**: JSON string containing complete library data
- **output_count**: Number of outputs for the node
- **Automatic Updates**: Real-time synchronization with frontend changes

#### Update Triggers
- Entry creation, modification, or deletion
- Group changes (creation, deletion, reordering)
- Prompt modifications (creation, deletion, reordering)
- Property changes (weights, random counts, shuffle settings)

## API Endpoints

### 1. Entry Management

#### List All Entries
```
GET /xyz/prompt_library/entries
Response: {"entries": {entry_id: entry_data, ...}}
```

#### Get Specific Entry
```
GET /xyz/prompt_library/entry/{entry_id}
Response: entry_data or {"error": "entry not found"}
```

#### Save Entry
```
POST /xyz/prompt_library/entry
Body: {"id": "entry_id", "data": entry_data}
Response: {"ok": true} or {"error": "error message"}
```

#### Save All Entries
```
POST /xyz/prompt_library/save_all
Body: {"entries": {entry_id: entry_data, ...}}
Response: {"ok": true, "saved_count": N, "total_count": M}
```

#### Delete Entry
```
DELETE /xyz/prompt_library/entry/{entry_id}
Response: {"ok": true} or {"error": "entry not found"}
```

### 2. Error Handling

#### HTTP Status Codes
- **200**: Success
- **400**: Bad request (missing parameters)
- **404**: Entry not found
- **409**: Entry already exists
- **500**: Internal server error

#### Error Response Format
```json
{
  "error": "Human-readable error message"
}
```

## Usage Examples

### 1. Basic Prompt Library

#### Create Entry Structure
1. Open the Prompt Library Window
2. Click "+" to create a new entry
3. A group and empty prompt are automatically created
4. Edit entry properties (name, tags, weights)
5. Add prompts to the group

#### Simple Prompt Template
```
Template: "A beautiful [nature] landscape with [style] art style"
Library: 
  - Entry "Nature" with tag "nature"
  - Entry "Art Styles" with tag "style"
Result: "A beautiful [Nature] landscape with [Art Styles] art style"
```

### 2. Advanced Random Selection

#### Entry with Random Groups
```json
{
  "name": "Character Prompts",
  "random": "2:1",
  "shuffle": false,
  "groups": [
    {"name": "Hair", "random": "1-2"},
    {"name": "Eyes", "random": "1"},
    {"name": "Clothing", "random": "1-3"}
  ]
}
```
- Selects 2 random active groups
- Includes 1 random inactive group
- Preserves order of selected groups

#### Group with Random Prompts
```json
{
  "name": "Hair Styles",
  "random": "3",
  "shuffle": true,
  "prompts": [
    {"context": "long hair", "weight": "1.5"},
    {"context": "short hair", "weight": "1.0"},
    {"context": "curly hair", "weight": "2.0"}
  ]
}
```
- Selects 3 random prompts
- Shuffles the selection order
- Applies individual prompt weights

### 3. Complex Pattern Combinations

#### Multi-Level References
```
Template: "A {portrait|landscape} featuring [[anime]] style with [Character/Clothing]"
```

This template:
1. Randomly selects "portrait" or "landscape"
2. Finds entries with "anime" tag and randomly selects one
3. References the "Clothing" group from "Character" entry
4. Applies all random selection and weight algorithms

#### Weighted Alternation with Library References
```
Template: "A {beautiful:1.5|stunning:2.0} [[nature] landscape]"
```

This template:
1. Selects "beautiful" (1.5 weight) or "stunning" (2.0 weight)
2. Finds entries with "nature" tag and randomly selects
3. Combines the adjective with the landscape description

## Best Practices

### 1. Organization

#### Entry Naming
- Use descriptive, consistent names
- Include category prefixes (e.g., "Character_", "Style_")
- Avoid special characters that might cause file issues

#### Tag Strategy
- Use broad, reusable tags
- Avoid overly specific tags
- Group related concepts under common tags

#### Group Structure
- Keep groups focused on single concepts
- Use logical hierarchies (e.g., "Character" → "Hair" → "Color")
- Balance group sizes for effective random selection

### 2. Random Selection

#### Active vs Inactive
- **Active**: Items you want to include regularly
- **Inactive**: Items for occasional variety
- Use colon syntax to control both independently

#### Weight Management
- Start with base weight of 1.0
- Use 0.5-2.0 range for subtle emphasis
- Avoid extreme weights (>5.0) that might skew results

#### Order Preservation
- Enable shuffle for variety
- Disable shuffle for consistent ordering
- Use order indices for precise control

### 3. Performance

#### Library Size
- Keep individual entries under 100 prompts
- Split large libraries into multiple entries
- Use tags for cross-referencing

#### Caching
- The system automatically caches frequently used data
- Browser storage provides offline access
- Widget synchronization ensures real-time updates

## Troubleshooting

### 1. Common Issues

#### Prompts Not Appearing
- Check if the entry/group is marked as active
- Verify the random count settings
- Ensure prompts have valid order indices

#### Random Selection Not Working
- Check random count syntax (no spaces around colon)
- Verify shuffle settings
- Ensure sufficient active items for selection

#### Widget Synchronization Issues
- Refresh the ComfyUI page
- Check browser console for errors
- Verify node widget connections

### 2. Debug Information

#### Frontend Debug
- Open browser developer tools
- Check console for error messages
- Verify localStorage contents

#### Backend Debug
- Check ComfyUI server logs
- Verify API endpoint responses
- Test with simple prompt templates

### 3. Data Recovery

#### From Browser Cache
- Check localStorage for cached entries
- Use the "Reload" button to restore from disk
- Export data before clearing cache

#### From Disk
- Check `@prompt_library/` folder for JSON files
- Verify file permissions and syntax
- Restore from backup if available

## Future Enhancements

### 1. Planned Features

#### Advanced Pattern Recognition
- Regular expression support
- Conditional logic based on tags
- Dynamic weight calculation

#### Import/Export
- CSV/TSV import from spreadsheet applications
- JSON schema validation
- Backup and restore functionality

#### Collaboration Features
- Shared library repositories
- Version control for entries
- User permission management

### 2. Performance Improvements

#### Lazy Loading
- Load entries on demand
- Cache frequently used data
- Optimize large library handling

#### Advanced Caching
- Redis backend for high-performance scenarios
- Compression for large datasets
- Incremental updates

### 3. Integration Enhancements

#### External APIs
- Integration with prompt databases
- AI-powered prompt suggestions
- Cross-platform synchronization

#### Workflow Integration
- Automatic prompt template generation
- Workflow-specific library subsets
- Prompt usage analytics

## Contributing

### 1. Development Setup

#### Prerequisites
- ComfyUI development environment
- Python 3.8+
- Modern web browser with ES6+ support

#### Local Development
1. Clone the repository
2. Install dependencies
3. Run ComfyUI in development mode
4. Make changes and test locally

### 2. Code Standards

#### JavaScript
- Use ES6+ syntax
- Follow JSDoc documentation standards
- Maintain consistent error handling

#### Python
- Follow PEP 8 style guidelines
- Use type hints where appropriate
- Include comprehensive docstrings

#### Testing
- Test with various library sizes
- Verify random selection algorithms
- Test edge cases and error conditions

### 3. Pull Request Process

1. Create feature branch
2. Implement changes with tests
3. Update documentation
4. Submit pull request with description
5. Address review feedback

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

### 1. Documentation
- This README provides comprehensive usage information
- Check the code comments for implementation details
- Review the API documentation for backend integration

### 2. Community
- GitHub Issues for bug reports and feature requests
- ComfyUI Discord for community support
- Wiki pages for additional tutorials and examples

### 3. Development
- Active development and maintenance
- Regular updates and bug fixes
- Community-driven feature development

---

**Note**: This prompt library system represents a significant advancement in ComfyUI prompt management, providing professional-grade organization and automation capabilities for AI art workflows.
