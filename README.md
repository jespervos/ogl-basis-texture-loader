# ogl-basis-texture-loader
Adaptation of Threejs BasisTextureLoader for OGL

## Usage

```javascript
# import
import { Renderer } from 'ogl';
import { BasisTextureLoader } from "./basis-texture-loader";

# create
const renderer = new Renderer();
const basisLoader = new BasisTextureLoader(renderer.gl);

# load
const texture = await basisLoader.load('path/to/file.basis');
```
