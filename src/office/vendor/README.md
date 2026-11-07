# Bundled PDF reader/writer

`pypdf-6.18.1-py3-none-any.whl` is the unmodified pure-Python wheel from
[PyPI](https://pypi.org/project/pypdf/6.18.1/).
It provides PDF text extraction, merging and page selection without installing
anything into the user's Python environment. Python imports it directly as a ZIP.

The BSD-3-Clause license and copyright notices are included in the wheel's
`pypdf-6.18.1.dist-info/licenses/LICENSE`.

To restore this build dependency:

```sh
python -m pip download --no-deps --only-binary=:all: --dest src/office/vendor pypdf==6.18.1
```
