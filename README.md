# ogl-basis-texture-loader

Adaptation of Threejs BasisTextureLoader for [OGL](https://github.com/oframe/ogl)

## Usage

⚠️ Copy basis-transcoder directory to your public directory.

```javascript
// import
import { Renderer } from "ogl";
import { BasisTextureLoader } from "./basis-texture-loader";

BasisTextureLoader.setTranscoderPath("you-public-directory/transcoder");

// create
const renderer = new Renderer();
const basisLoader = new BasisTextureLoader(renderer.gl);

// load
const texture = await basisLoader.load("path/to/file.basis");
```
