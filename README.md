# ogl-basis-texture-loader

Adaptation of Threejs BasisTextureLoader for [OGL](https://github.com/oframe/ogl)

## Usage

⚠️ Copy transcoder directory to your public directory.

```javascript
// import
import { Renderer } from "ogl";
import { BasisTextureLoader } from "./basis-texture-loader";

// create
const renderer = new Renderer();
const basisLoader = new BasisTextureLoader(renderer.gl);
basisLoader.setTranscoderPath("you-public-directory/transcoder");

// load
const texture = await basisLoader.load("path/to/file.basis");
```
