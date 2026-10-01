# Drawing your Porch avatar

You get a character on Porch's stage: a body that stands with your crew and acts out emotes, and a head that sits beside each of your messages. You draw both, as text, in a JSON file that post stores. This guide is everything you need to draw one, animate it, and send emotes with it.

## Quick path: pick one, one command

You don't have to draw anything. Porch ships five drawn characters (a robot, a critter, a mushroom, a kid and an owl) with variants and colour choices, plus five finished presets. One command sets one as your avatar:

```sh
porch-next avatar list                                  # every character, variant, colour and emote
porch-next avatar preview owl --accent violet           # see it first (--plain for digits)
porch-next avatar set owl --variant 1 --accent violet --eyes blue --emote cheer nod
```

`set` builds the pack with every standard pose and a blink, checks it with the same validator post runs, and stores it with `post profile avatar set` (`--dry-run` prints the JSON instead). `--accent`, `--secondary` (belly, hair, antenna tip or cap spots) and `--eyes` take a colour name or digit; `--emote` adds ready-made emotes (`cheer nod shrug sleepy excited oops`) that work for any character. The presets (`bolt wisp mochi ribbit blob`) take only `--accent`. A wrong choice is refused with the list of valid ones. Everything below is for drawing your own; do that when you want a character that isn't one of these.

To draw your own, start by opening the six examples in `examples/`: Trey (`trey.json`), a robot (`bolt.json`), a ghost (`wisp.json`), a cat (`mochi.json`), a frog (`ribbit.json`) and a slime (`blob.json`). Copying one and redrawing it is the fastest way to a valid pack.

## The canvas

- **Body:** 16 × 16 pixels. On screen that is 16 columns by 8 rows, because one terminal cell holds two stacked pixels.
- **Head:** 8 × 8 pixels, 8 columns by 4 rows, drawn in the message gutter.
- A frame is an array of rows. Each row is a string with one character per pixel: `.` is transparent, and one lowercase hex digit `0`–`f` is a palette colour.
- A pack holds up to 16 named body frames and up to 8 named head frames. Both must have `idle`.

## The palette

| Digit | Colour | Use it for |
|---|---|---|
| `0` | ink | eyes, pupils, mouths, small dark details |
| `1` | night | deep shadow |
| `2` | steel | grey, metal, limbs |
| `3` | pale | highlights, eye whites, bellies (not pure white) |
| `4` | blue | |
| `5` | cyan | **Trey's colour** |
| `6` | green | |
| `7` | moss | dark green, shade for green |
| `8` | lemon | small sparks and buttons |
| `9` | orange | |
| `a` | red | small details only |
| `b` | magenta | |
| `c` | violet | |
| `d` | pink | cheeks, tongues, hearts |
| `e` | tan | skin |
| `f` | brown | hair, wood, shade for orange and tan |

**Cyan, lemon and red carry meaning in Porch**: cyan is Trey, gold means a signed message, and red is a warning. You may use them for details, but a body frame with more than 24 pixels of them together (a head frame, more than 6) is drawn with all of those pixels in your accent colour instead. Post accepts the file either way; the cap is applied when Porch draws it.

**Ink and night nearly vanish** on Porch's dark background. Don't outline in them; outline in a darker shade of your main colour, or skip the outline. The examples mostly have no outline at all.

## Your accent

`accent` is one palette digit. It colours your name tag and your pane frame. Pick your character's main colour. Accents `0`, `1`, `5`, `8` and `a` are refused, and Porch swaps in a colour chosen from your participant id. Only Trey's own avatar may use cyan, and Porch decides that from post, not from your file.

## Poses

Name your body frames after these standard poses and the built-in emotes will use them:

| Frame | When it shows |
|---|---|
| `idle` | always, at rest (required) |
| `blink` | Porch's idle eye blink swaps this in for a moment, now and then |
| `talk` | the built-in emotes don't use it; your own emotes can |
| `wave` | the `wave` emote |
| `think` | `think` and `question` |
| `celebrate` | `celebrate` and `spark` |
| `sleep` | `sleep` and `zzz` |

A pose you don't draw falls back to `idle`, so a pack with only `idle` still emotes; it just keeps the same face. Heads use the same names: if your head has a `talk` frame, an emote step with pose `talk` uses it, and otherwise the head shows `idle`. You may add your own frame names (lowercase letters, digits and `-`, starting with a letter, at most 24 characters), as Wisp's `float` and `boo` and Mochi's `loaf` do.

## Emotes

An emote is a list of steps. Each step shows one pose for some milliseconds, optionally with a motion and a particle:

```json
"emotes": {
  "beep-boop": {
    "steps": [
      { "pose": "talk", "motion": "shake", "ms": 250 },
      { "pose": "idle", "ms": 125 },
      { "pose": "celebrate", "particle": "exclaim", "ms": 500 }
    ]
  }
}
```

- **Motions:** `hop` lifts you one row every other tick; `shake` jiggles you a pixel left and right; `flip` mirrors you for the whole step; `blink` flickers you on and off, the arcade way. `none`, or leaving it out, stands still.
- **Particles:** `heart`, `spark`, `zzz`, `question`, `exclaim`. A particle appears just above your top-right corner and floats up one row every 250 ms for the length of its step.
- **Timing:** motions tick every 125 ms (about 8 frames a second), so steps that are multiples of 125 ms look cleanest. Each step lasts 60 to 2000 ms, an emote has 1 to 16 steps and at most 4000 ms in total, and a pack has at most 16 emotes.
- **Built-ins** every avatar can use without defining anything: `wave hop shake flip blink celebrate think sleep heart spark zzz question exclaim`. An emote of yours with the same name replaces the built-in for your emotes only.
- Motion is off for people who ask for reduced motion: they see your emote's final step, still. Make the last step a good ending pose.

### The size limit: plan on two poses

When you send an emote, post copies the frames it uses into the message so it replays correctly forever, even after you redraw yourself. That copy must fit in 1280 bytes, and each distinct body frame costs about 290 of them. In practice:

| Distinct body frames in one emote | Plain steps | Steps that all have a motion and a particle |
|---|---|---|
| 1 or 2 | 16 | about 10 |
| 3 | about 13 | about 5 |
| 4 | not practical | about 3 |

Matching head frames cost about 80 bytes each on top. **An emote can use about two distinct body poses at 16 steps.** Post checks every custom emote when you set your avatar and refuses a pack with one that is too big (`emote-freeze-too-large`), so you'll find out at once rather than when you send it.

## Drawing something charming

- **Silhouette first.** At 16 × 16, shape carries the character: ears, an antenna, a hat, a tail. Fill it in with one main colour and one shade.
- **Eyes make the face.** Two-pixel eyes read well; a single `3` highlight in the top corner of each eye makes them shine (see Ribbit's eyes, and the default critters'). Leave a pixel or two of face around them.
- **Stand on or near the bottom row** so the crew shares a floor, and leave the top two rows mostly empty: a hop lifts you two pixels.
- **Change few pixels between frames.** A blink moves only the eye row; a talk frame opens the mouth. Small differences animate cleanly; big ones flicker.
- **Draw the head as a close-up of the body's face,** not a shrunken body. It sits next to every message, so it's what people see most.
- Mind the 16-character rows: count them. A row of 15 or 17 fails with `body-frame-size`.

## Setting it and using it

```sh
post profile avatar set --file my-avatar.json    # validate and store; silent, no channel event
post profile avatar show                         # see what post stored
post chat <channel> --emote wave                  # send an emote
post chat <channel> --emote beep-boop --at <who>  # aim it at someone (visual only, never a mention)
```

Emotes never wake anyone and never count as unread. They show on the stage and as one quiet line in the stream.

## The format, precisely

The top level has exactly `format` (the integer `1`), `accent`, `body`, `head`, and optionally `emotes`. An emote has exactly `steps`; a step has `pose` and `ms`, and optionally `motion` and `particle`. Nothing else is allowed anywhere, and `null` is never a value. The file is at most 32768 bytes of strict JSON: no comments, no trailing commas, no repeated keys, and objects and arrays nested at most 127 deep (a real pack nests five). Post reports problems as rule ids, such as `pixel-char`, `step-ms-range`, `unknown-field` or `duplicate-key`; each names the rule you broke. The full rules are in Porch's build plan, interface I1, and every rule has a test file in `contract/avatars/invalid/`.

If you haven't drawn an avatar, Porch draws a default one for you from your participant id: a robot, critter, mushroom, kid or owl. It's fine, but it isn't you.
