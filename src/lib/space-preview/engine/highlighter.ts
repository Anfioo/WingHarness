// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import hljs from 'highlight.js/lib/common';
import apache from 'highlight.js/lib/languages/apache';
import armasm from 'highlight.js/lib/languages/armasm';
import asciidoc from 'highlight.js/lib/languages/asciidoc';
import autohotkey from 'highlight.js/lib/languages/autohotkey';
import autoit from 'highlight.js/lib/languages/autoit';
import awk from 'highlight.js/lib/languages/awk';
import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import fortran from 'highlight.js/lib/languages/fortran';
import fsharp from 'highlight.js/lib/languages/fsharp';
import glsl from 'highlight.js/lib/languages/glsl';
import groovy from 'highlight.js/lib/languages/groovy';
import handlebars from 'highlight.js/lib/languages/handlebars';
import haskell from 'highlight.js/lib/languages/haskell';
import julia from 'highlight.js/lib/languages/julia';
import latex from 'highlight.js/lib/languages/latex';
import lisp from 'highlight.js/lib/languages/lisp';
import llvm from 'highlight.js/lib/languages/llvm';
import nginx from 'highlight.js/lib/languages/nginx';
import ocaml from 'highlight.js/lib/languages/ocaml';
import powershell from 'highlight.js/lib/languages/powershell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';
import scheme from 'highlight.js/lib/languages/scheme';
import stylus from 'highlight.js/lib/languages/stylus';
import twig from 'highlight.js/lib/languages/twig';
import verilog from 'highlight.js/lib/languages/verilog';
import vhdl from 'highlight.js/lib/languages/vhdl';

for (const [name, grammar] of Object.entries({
  apache,
  armasm,
  asciidoc,
  autohotkey,
  autoit,
  awk,
  clojure,
  cmake,
  dart,
  dockerfile,
  dos,
  elixir,
  erlang,
  fortran,
  fsharp,
  glsl,
  groovy,
  handlebars,
  haskell,
  julia,
  latex,
  lisp,
  llvm,
  nginx,
  ocaml,
  powershell,
  protobuf,
  scala,
  scheme,
  stylus,
  twig,
  verilog,
  vhdl,
}))
  hljs.registerLanguage(name, grammar);
export default hljs;
