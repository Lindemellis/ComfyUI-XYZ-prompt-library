# CharacterSheet 两个 Krea 2 LoRA 的提示词

来源：<https://huggingface.co/Alissonerdx/CharacterSheet>

## QuadView_krea2_v1

```text
Convert the character in the image to a Character Sheet showing a face close-up, front full body, side full body and back full body views
```

## DynamicCharacterSheet_krea2_v1

结构是：方括号头 → 保真声明 → **你要的版式** → 身份锁 → 文字规则 → 负面约束。

```text
[TASK: ENTITY_SHEET_GENERATION]
[TEMPLATE: MULTI_ANGLE_ENTITY_SHEET_V1]
[ENTITY_TYPE: <类型>]
[ENTITY_ID: <类型小写>_<短名>]

Convert the subject in Image 1 into one standardized advanced Character Sheet. Image 1 is the sole identity and design reference for <名字>. Preserve the exact same design, proportions, colors, materials, markings, surface wear, and every signature detail. Do not redesign, beautify, age-shift, or simplify it.

FIXED LANDSCAPE SHEET FORMAT
<画布描述，然后逐条列出你要的分区>

IDENTITY LOCKS
- <特征 1>
- <特征 2>
- <特征 3>
- <特征 4，可到 7 条>
- Keep the subject from Image 1 recognizable in every view.
- Keep handedness, asymmetry, markings, costume, hardware, and color placement consistent.
- Use <画风> throughout the sheet.

VISIBLE TEXT
All labels must be English only. Keep labels short and legible. Do not invent lore paragraphs.

NEGATIVE CONSTRAINTS
No extra character or object, identity drift, species drift, wardrobe drift, material drift, inconsistent markings, changed proportions, missing extremities, duplicated limbs, merged views, overlapping panels, logo, watermark, or unrelated decoration.
```

### 版式那段自己写

分区的数量、位置、画布比例都由你定，随附工作流用的是这一种，可以直接拿来改：

```text
FIXED LANDSCAPE SHEET FORMAT
Use a clean 3:2 landscape canvas with a warm off-white paper background and generous white space. Organize one coherent sheet with these fixed zones:
1. LEFT METADATA COLUMN: the exact name "<名字>", ENTITY TYPE, CORE MOOD, and VISUAL SIGNATURE in compact readable English.
2. LARGE CENTER HERO VIEW: one dominant full-body or complete-object three-quarter view.
3. TOP-RIGHT TURNAROUND ROW: neutral FRONT FULL BODY, SIDE FULL BODY, and BACK FULL BODY views at matching scale, with all extremities visible.
4. MID-RIGHT ACTION POSES: three readable views including a low angle, an overhead or high angle, and one characteristic action or operating state.
5. BOTTOM-LEFT SILHOUETTE STUDY: three solid black silhouettes that preserve the design shape.
6. BOTTOM-CENTER EXPRESSION STUDY: one clear neutral face close-up plus three compact expression, state, or functional studies showing meaningful variation without changing identity or construction.
7. BOTTOM-RIGHT DETAIL STUDY: six close-up crops of the most identity-critical features, materials, joints, face, markings, controls, or accessories.
```

用这一种的话，两处标签按类型换词：

- 第 4 条 `ACTION POSES` —— `OBJECT` 改成 `FUNCTIONAL CONFIGURATIONS`
- 第 6 条 `EXPRESSION STUDY` —— `ROBOT` / `VEHICLE` / `OBJECT` 改成 `STATE / FUNCTION STUDY`

`CORE MOOD` 和 `DETAIL STUDY` 的具体内容不用写，模型自己会补。

### 其余占位符

| 占位符 | 填法 |
|---|---|
| `<类型>` | `HUMAN` 写实真人 · `STYLIZED_CHARACTER` 动画/游戏风人形 · `ANIMAL` 真实动物 · `CREATURE` 奇幻生物 · `ROBOT` · `VEHICLE` · `OBJECT` 无生命物件 |
| `<类型小写>_<短名>` | 小写 snake_case，如 `human_lena_professional`、`animal_fenna_fox` |
| `<名字>` | 角色名，正文和版式段里都要用，保持一致 |
| `<特征 N>` | 4–7 条。只写图里看得见、别人照着能画出来的：确切颜色、纹样、不对称处、配件形状、材质。不能编图里没有的 |
| `<画风>` | 如 `clean anime cel-shaded illustration style with sharp linework`、`naturalistic wildlife concept art with anatomically credible fur, paws, and motion`、`premium photoreal product concept rendering with precise metal, wood, glass, and matte surfaces` |

### 一份填好的（HUMAN，用上面那种版式）

```text
[TASK: ENTITY_SHEET_GENERATION]
[TEMPLATE: MULTI_ANGLE_ENTITY_SHEET_V1]
[ENTITY_TYPE: HUMAN]
[ENTITY_ID: human_lena_professional]

Convert the subject in Image 1 into one standardized advanced Character Sheet. Image 1 is the sole identity and design reference for Lena. Preserve the exact same design, proportions, colors, materials, markings, surface wear, and every signature detail. Do not redesign, beautify, age-shift, or simplify it.

FIXED LANDSCAPE SHEET FORMAT
Use a clean 3:2 landscape canvas with a warm off-white paper background and generous white space. Organize one coherent sheet with these fixed zones:
1. LEFT METADATA COLUMN: the exact name "Lena", ENTITY TYPE, CORE MOOD, and VISUAL SIGNATURE in compact readable English.
2. LARGE CENTER HERO VIEW: one dominant full-body or complete-object three-quarter view.
3. TOP-RIGHT TURNAROUND ROW: neutral FRONT FULL BODY, SIDE FULL BODY, and BACK FULL BODY views at matching scale, with all extremities visible.
4. MID-RIGHT ACTION POSES: three readable views including a low angle, an overhead or high angle, and one characteristic action or operating state.
5. BOTTOM-LEFT SILHOUETTE STUDY: three solid black silhouettes that preserve the design shape.
6. BOTTOM-CENTER EXPRESSION STUDY: one clear neutral face close-up plus three compact expression, state, or functional studies showing meaningful variation without changing identity or construction.
7. BOTTOM-RIGHT DETAIL STUDY: six close-up crops of the most identity-critical features, materials, joints, face, markings, controls, or accessories.

IDENTITY LOCKS
- long wavy auburn hair reaching mid-thigh with center-parted blunt bangs
- fair skin with subtle blush on cheeks and defined red lips
- white button-down blouse with collar and cuffs, no tie or scarf
- dark navy pleated skirt ending at mid-thigh, belt at waistline
- black block-heeled pumps
- Keep the subject from Image 1 recognizable in every view.
- Keep handedness, asymmetry, markings, costume, hardware, and color placement consistent.
- Use clean anime cel-shaded illustration style with sharp linework throughout the sheet.

VISIBLE TEXT
All labels must be English only. Keep labels short and legible. Do not invent lore paragraphs.

NEGATIVE CONSTRAINTS
No extra character or object, identity drift, species drift, wardrobe drift, material drift, inconsistent markings, changed proportions, missing extremities, duplicated limbs, merged views, overlapping panels, logo, watermark, or unrelated decoration.
```
