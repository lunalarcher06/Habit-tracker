# Brief: the 12 outfits, with the same behaviour as the plain cat

## What the app does with an outfit
When the player wears an outfit, the cat must do **everything it normally does**, just dressed:

- sit and look at you (the main pose), the happy face with the tail up (celebration), the mean face with a "!" (habit missing),
- stand up, walk (and turn round), sit down, wash its face, jump,
- close its eyes, lie down and sleep.

The app is already built for this. For each outfit it looks in `ui/cat/outfits/<name>/` for the **same pictures, with the same file names and layout, as the plain cat has in `ui/cat/`**. As soon as a folder has them, the cat uses them for everything. Until then it shows the single old picture of that outfit, which can only hop and waddle (and is a different-looking cat).

## What I need for each outfit
**One green-screen video per outfit, following the same timeline as the plain cat's video**, with the cat wearing the outfit. The reference is the last part of `Walking cat video (3).mp4` plus the walking clip, i.e. the sequence the plain cat's pictures came from. The order, with the same camera, ground line and cat size every time:

1. The cat **walks in place** at a steady pace, side view facing right, for about 5 seconds (the full cycle repeats cleanly).
2. It **slows, stops and sits down** (side view), then **stands up** again.
3. It **sits and washes its face** with a paw (about 3 seconds).
4. It **stands up, walks, turns toward the camera and sits facing the viewer**, calm, eyes open (the main pose), 2 seconds.
5. **Happy**: mouth open, tail up (2 seconds), then it relaxes back to calm.
6. **Mean face**: eyes narrow into a flat, annoyed glare (1 second), then back to calm.
7. Eyes narrow and **close, it lowers itself down and lies asleep** (3 seconds).

Rules for every video: same cat as the plain cat (face, fur, colours, proportions, drawing style), the **outfit and its small props stay on the cat in every frame** (props can sit beside it on the floor), flat solid green background, whole cat including the tail always in frame, no camera movement, 1920×1080 at 30 fps.

If your tool takes a first frame and a last frame, give it the plain cat's frame as the starting point.

### The prompt (replace the outfit text)
> Redraw this video with the cat wearing the outfit below. Keep the cat, its face, fur, pose, size, position, the camera and the timing of every movement **exactly the same**. The outfit and its props must stay on the cat in every frame. Flat solid green background, nothing else. Outfit: [the text from the table]

### The 12 outfits

| Folder name | Unlocked at | Outfit |
|---|---|---|
| `headphones` | 3 days | Large glowing blue over-ear headphones. |
| `cool` | 7 days | Black sunglasses and a long red-and-cream striped knitted scarf. |
| `chef` | 14 days | Tall white chef's hat, a whisk tucked beside it. |
| `bookworm` | 21 days | Round glasses and a small leather book tucked under one paw. |
| `wizard` | 30 days | Purple pointed wizard hat with gold stars and a moon. |
| `aviator` | 45 days | Brown leather aviator cap with goggles and a shearling-collar flying jacket. |
| `sheriff` | 60 days | Brown cowboy hat with a gold star badge, brown leather vest and a neckerchief. |
| `astronaut` | 90 days | Clear bubble helmet and a patched astronaut vest. |
| `lucky` | 100 days | Red-and-gold embroidered jacket. |
| `ninja` | 150 days | Navy hood and face mask, a katana on its back. |
| `cyberpunk` | 200 days | Glowing cyan eye visor and a neon green harness. |
| `royal` | 365 days | Gold jewelled crown and a red velvet cape with white ermine trim. |

Keep props small and on the cat: a prop on the floor beside it can be lost when the cat walks, because the cat moves and the props do not.

## What I do with the videos
Send me the 12 videos. I cut out the green, find each part of the timeline, and build the pictures into `ui/cat/outfits/<name>/` in exactly the layout above. From then on that outfit does everything the plain cat does. If a video is missing a part (for example no sleeping), the cat simply skips that behaviour in that outfit.

## Also: clips that would make the plain cat's movement smoother
The pictures come from separate videos, so where one clip meets another there can be a small mismatch. These clips would remove most of it (same camera, ground line and cat size, flat green background, whole cat in frame):

1. **Turn in place, both ways.** From standing still, the cat turns 180° on the spot until it faces the other way and stands still. One clip each way, about 2 seconds.
2. **Start and stop.** From standing still to a steady walk (about 1.5 seconds), and from a steady walk to standing still. Their first and last frames must match the matching frame of the walk loop.
3. **A walk that loops perfectly.** 4 to 6 seconds of steady walking where the last frame equals the first.
4. **Stand up and sit down**, starting and ending in the same standing pose as the clips above.
