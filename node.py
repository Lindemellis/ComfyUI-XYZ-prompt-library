import re
import random

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
      

class MultiTextConcate:
    
    @classmethod    
    def INPUT_TYPES(s):
        return {
            "optional": {
                "prefix": ("STRING", {"forceInput": True}),
                "suffix": ("STRING", {"forceInput": True}),
            },
            "required": {
                "delimiter": ("STRING", {"default": ", "}),
                "clean_whitespace": (["true", "false"],),
            }, 
        }
    
    RETURN_TYPES = ByPassTypeTuple(("STRING", "STRING",))
    RETURN_NAMES = ByPassTypeTuple(("ALL", "NONE",))
    FUNCTION = "concate_and_encode"
    CATEGORY = "XYZ Node"

    @classmethod
    def IS_CHANGED(s, **kargs):
        return 
    
    def concate_and_encode(self, delimiter, clean_whitespace, prefix, suffix, **kwargs):
        prefix = prefix or ""
        suffix = suffix or ""
        if clean_whitespace == "true":
            prefix = prefix.strip().rstrip(',')
            suffix = suffix.strip().rstrip(',')
        list = []
        all = []
        for val in kwargs.values():
            if clean_whitespace == "true":
                val = val.strip().rstrip(',')
            all.append(val)
            l = [prefix, val, suffix]
            l = [s for s in l if s]
            list.append(delimiter.join(l))
        all = [prefix] + all + [suffix]
        all = [s for s in all if s]
        list = [delimiter.join(all)] + list
        return tuple(list)


class MutiTextReplace:
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template": ("STRING",  {"default": "", "multiline": True}),
            },
        }
    
    RETURN_TYPES = ByPassTypeTuple(("STRING", "STRING", ))
    RETURN_NAMES = ByPassTypeTuple(("ALL", "NONE", ))
    FUNCTION = "replace_template"
    CATEGORY = "XYZ Node"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return
    
    def clean_and_format_strings(self, string_list: list) -> list:
        # Remove empty strings and strip whitespace from each string
        cleaned_list = [s.strip(", \t\n") for s in string_list]
        cleaned_list = [s for s in cleaned_list if s]

        # Ensure each string ends with exactly one comma
        #formatted_list = [s + ',' if not s.endswith(',') else s for s in cleaned_list[:-1]] + [cleaned_list[-1]]

        return cleaned_list
    
    def replace_template(self, template: str, **kwargs) -> list:
        # Extract placeholders in the form of "[digit]" from the template
        placeholders = re.findall(r'\[\d+\]', template)
        
        # Split the template by placeholders while preserving them
        template_parts = [term.strip() for term in re.split(r'(\[\d+\])', template)]
        
        # Initialize overall replacements dictionary and output strings list
        overall_replacements = {int(p[1:-1]): [] for p in placeholders}
        output_strings = []

        # Process each input string in a single loop
        for input_string in kwargs.values():
            # Create a dictionary mapping placeholder indices to corresponding values
            input_dict = {int(key): value.strip() for key, value in re.findall(r'\[(\d+)\]\s*([^[]+?)(?=\s*\[\d+\]|$)', input_string)}
            
            # Initialize output list as a copy of template_parts
            output = template_parts.copy()
            
            # Replace placeholders and build overall replacements
            for placeholder in placeholders:
                placeholder_index = int(placeholder[1:-1])
                if placeholder_index in input_dict:
                    output = [input_dict[placeholder_index] if term == placeholder else term for term in output]
                    overall_replacements[placeholder_index].append(input_dict[placeholder_index])
                else:
                    output = [term for term in output if term != placeholder]
            
            # Join the output list into a single string and add to the output list
            output_strings.append(',\n'.join(self.clean_and_format_strings(output)))

        template_output = template_parts.copy()
        template_output = [term for term in template_output if term not in placeholders]
        # Add the template only string to the beginning of the output strings list
        output_strings.insert(0, ",\n".join(self.clean_and_format_strings(template_output)))

        # Build overall output by replacing placeholders with their accumulated values
        overall_output = template_parts.copy()
        for placeholder in placeholders:
            placeholder_index = int(placeholder[1:-1])
            if overall_replacements[placeholder_index]:
                replacement_text = ", ".join(self.clean_and_format_strings(overall_replacements[placeholder_index]))
                overall_output = [replacement_text if term == placeholder else term for term in overall_output]
            else:
                overall_output = [term for term in overall_output if term != placeholder]

        # Add the overall string to the beginning of the output strings list
        output_strings.insert(0, ",\n".join(self.clean_and_format_strings(overall_output)))
        
        return output_strings
    

class MultiClipEncoder:
    
    @classmethod    
    def INPUT_TYPES(s):
        return { 
            "required":  { 
                "clip": ("CLIP",),
                "positive": ("STRING", {"default": "", "multiline": True}),
                "negative": ("STRING", {"default": "", "multiline": True}),
            },
        }
    
    RETURN_TYPES = ByPassTypeTuple(("CONDITIONING", "CONDITIONING", ))
    RETURN_NAMES = ByPassTypeTuple(("POSITIVE", "NEGATIVE",))
    FUNCTION = "multi_encode"
    CATEGORY = "XYZ Node"

    def multi_encode(self, clip, **kwargs):
        list = []
        for val in kwargs.values():
            list.append(self.encode(clip, val))
        return tuple(list)
    
    def encode(self, clip, text):
        tokens = clip.tokenize(text)
        output = clip.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
        cond = output.pop("cond")
        return [[cond, output]]
    

class Example:
    """
    A example node

    Class methods
    -------------
    INPUT_TYPES (dict):
        Tell the main program input parameters of nodes.
    IS_CHANGED:
        optional method to control when the node is re executed.

    Attributes
    ----------
    RETURN_TYPES (`tuple`):
        The type of each element in the output tuple.
    RETURN_NAMES (`tuple`):
        Optional: The name of each output in the output tuple.
    FUNCTION (`str`):
        The name of the entry-point method. For example, if `FUNCTION = "execute"` then it will run Example().execute()
    OUTPUT_NODE ([`bool`]):
        If this node is an output node that outputs a result/image from the graph. The SaveImage node is an example.
        The backend iterates on these output nodes and tries to execute all their parents if their parent graph is properly connected.
        Assumed to be False if not present.
    CATEGORY (`str`):
        The category the node should appear in the UI.
    DEPRECATED (`bool`):
        Indicates whether the node is deprecated. Deprecated nodes are hidden by default in the UI, but remain
        functional in existing workflows that use them.
    EXPERIMENTAL (`bool`):
        Indicates whether the node is experimental. Experimental nodes are marked as such in the UI and may be subject to
        significant changes or removal in future versions. Use with caution in production workflows.
    execute(s) -> tuple || None:
        The entry point method. The name of this method must be the same as the value of property `FUNCTION`.
        For example, if `FUNCTION = "execute"` then this method's name must be `execute`, if `FUNCTION = "foo"` then it must be `foo`.
    """
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        """
            Return a dictionary which contains config for all input fields.
            Some types (string): "MODEL", "VAE", "CLIP", "CONDITIONING", "LATENT", "IMAGE", "INT", "STRING", "FLOAT".
            Input types "INT", "STRING" or "FLOAT" are special values for fields on the node.
            The type can be a list for selection.

            Returns: `dict`:
                - Key input_fields_group (`string`): Can be either required, hidden or optional. A node class must have property `required`
                - Value input_fields (`dict`): Contains input fields config:
                    * Key field_name (`string`): Name of a entry-point method's argument
                    * Value field_config (`tuple`):
                        + First value is a string indicate the type of field or a list for selection.
                        + Second value is a config for type "INT", "STRING" or "FLOAT".
        """
        return {
            "required": {
                "positive": ("STRING", {"defaultInput": True}),
                "positive": ("STRING", {"defaultInput": True}),
                "positive": ("STRING", {"defaultInput": True}),
                "image": ("IMAGE",),
                "int_field": ("INT", {
                    "default": 0, 
                    "min": 0, #Minimum value
                    "max": 4096, #Maximum value
                    "step": 64, #Slider's step
                    "display": "number", # Cosmetic only: display as "number" or "slider"
                    "lazy": True # Will only be evaluated if check_lazy_status requires it
                }),
                "float_field": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.01,
                    "round": 0.001, #The value representing the precision to round to, will be set to the step value by default. Can be set to False to disable rounding.
                    "display": "number",
                    "lazy": True
                }),
                "print_to_screen": (["enable", "disable"],),
                "string_field": ("STRING", {
                    "multiline": False, #True if you want the field to look like the one on the ClipTextEncode node
                    "default": "Hello World!",
                    "lazy": True
                }),
            },
        }

    RETURN_TYPES = ("IMAGE","STRING", "STRING")
    #RETURN_NAMES = ("image_output_name",)

    FUNCTION = "test"

    #OUTPUT_NODE = False

    CATEGORY = "XYZ Node"

    def check_lazy_status(self, image, string_field, int_field, float_field, print_to_screen):
        """
            Return a list of input names that need to be evaluated.

            This function will be called if there are any lazy inputs which have not yet been
            evaluated. As long as you return at least one field which has not yet been evaluated
            (and more exist), this function will be called again once the value of the requested
            field is available.

            Any evaluated inputs will be passed as arguments to this function. Any unevaluated
            inputs will have the value None.
        """
        if print_to_screen == "enable":
            return ["int_field", "float_field", "string_field"]
        else:
            return []

    def test(self, image, string_field, int_field, float_field, print_to_screen):
        if print_to_screen == "enable":
            print(f"""Your input contains:
                string_field aka input text: {string_field}
                int_field: {int_field}
                float_field: {float_field}
            """)
        #do some processing on the image, in this example I just invert it
        image = 1.0 - image
        return (image, "", "")

    """
        The node will always be re executed if any of the inputs change but
        this method can be used to force the node to execute again even when the inputs don't change.
        You can make this node return a number or a string. This value will be compared to the one returned the last time the node was
        executed, if it is different the node will be executed again.
        This method is used in the core repo for the LoadImage node where they return the image hash as a string, if the image hash
        changes between executions the LoadImage node is executed again.
    """
    #@classmethod
    #def IS_CHANGED(s, image, string_field, int_field, float_field, print_to_screen):
    #    return ""



import random

class RandomStringPicker:
    """
    A node that randomly selects and shuffles string items based on tags.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "multi_line_text": ("STRING", {
                    "multiline": True,
                    "default": ""
                }),
                "random_choice_min": ("INT", {
                    "default": 1,
                    "min": 0,
                    "max": 100,
                }),
                "random_choice_max": ("INT", {
                    "default": 3,
                    "min": 0,
                    "max": 100,
                }),
                "shuffle_all": ("BOOLEAN", {"default": False}),
                "shuffle_user_choice": ("BOOLEAN", {"default": False}),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xffffffffffffffff,
                    "tooltip": "Determines the random seed to be used for wildcard processing."
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "XYZ Node"

    def process(self, multi_line_text, random_choice_min, random_choice_max, shuffle_all, shuffle_user_choice, seed):
        random.seed(seed)

        # Step 1: Parse input
        items = [item.strip() for item in multi_line_text.strip().split(";") if item.strip()]
        tagged_1 = []
        untagged = []

        for item in items:
            if item.endswith(":1"):
                tagged_1.append(item.rsplit(":", 1)[0].strip())
            elif item.endswith(":0"):
                continue
            else:
                untagged.append(item)

        # Step 2: Shuffle tagged_1 if user requested
        if shuffle_user_choice:
            random.shuffle(tagged_1)

        # Step 3: Generate random choice count
        choice_count = random.randint(min(random_choice_min, random_choice_max), max(random_choice_min, random_choice_max))

        # Step 4: Sample untagged items
        random_choices = random.sample(untagged, min(choice_count, len(untagged)))

        # Step 5: Combine and optionally shuffle all
        final_list = tagged_1 + random_choices
        if shuffle_all:
            random.shuffle(final_list)

        return (", ".join(final_list),)
