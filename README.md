# lsdev

A command-line tool for navigating development directories. Quickly jump between source trees, build directories, and related projects with intelligent detection and fuzzy matching.

## Features

- **Smart directory detection**: Automatically detects project roots via `.git`, `CMakeLists.txt`, `configure`, and other markers
- **Source/build relationship tracking**: Links build directories to their source trees
- **Fuzzy matching**: Find directories with partial names using word, regex, or ido-style matching
- **Wildcard support**: Use glob patterns (`*`, `?`) in configuration files
- **Shell integration**: Designed to work with shell functions for seamless `cd` replacement

## Installation

### From source

```bash
git clone https://github.com/user/lsdev.ts.git
cd lsdev.ts
npm install
npm run build
```

Add the `bin` directory to your PATH, or create a symlink:

```bash
ln -s /path/to/lsdev.ts/bin/lsdev ~/.local/bin/lsdev
```

### Shell Integration

Add this to your `.bashrc` or `.zshrc`:

```bash
# Navigate to dev directories
cdd() {
    local dir
    dir=$(lsdev -w "$@")
    if [ -n "$dir" ] && [ -d "$dir" ]; then
        cd "$dir"
    fi
}

# Quick aliases
alias cdds="cdd src"      # Jump to source directory
alias cddb="cdd build"    # Jump to build directory
```

## Usage

```
lsdev [options] [matches...]
```

### Options

| Option | Description |
|--------|-------------|
| `-w` | Write selected directory to default file (for `-` shortcut) |
| `-r` | Select project root (don't guess subdirectories from current path) |
| `-l` | List matching directories without prompting for selection |
| `-p` | Print the name of the current project |
| `-a` | Include all source and build directories in output |
| `-b` | Only include relevant source/build directories |
| `-d` | Force detection of default directory |
| `-v` | Verbose output (useful for debugging configuration) |
| `-h` | Show help |

### Output Format Options

| Option | Description |
|--------|-------------|
| `-tp` | Output full path (default) |
| `-tn` | Output directory name only |
| `-ts` | Output simple name (from config or generated) |
| `-ta` | Output all info: name, path, and source reference |
| `-tS` | Output source directory path |
| `-tr` | Output the "rest" path (subdirectory within project) |

### Match Modifiers

| Option | Description |
|--------|-------------|
| `-me` | Exact match only |
| `-mw` | Word boundary match (default fallback) |
| `-mr` | Regular expression match |
| `-mi` | Ido-style fuzzy match (characters in order) |

### Special Matches

| Match | Description |
|-------|-------------|
| `-` | Jump to the last/default directory |
| `src` or `source` | Filter to source directories only |
| `build` | Filter to build directories only |
| `-<match>` | Exclude directories matching this pattern |
| `path:<regex>` | Match against full path |

## Configuration

### ~/.dev_directories

The main configuration file listing your development directories.

```ini
# Simple entries: name=path
myproject=/home/user/dev/myproject
work=/home/user/work/project

# Wildcard entries: automatically expand to all matching directories
projects=/home/user/dev/*
libs=/home/user/libs/lib-*

# Special keys
builds=/home/user/builds           # Directory containing build trees
sources=/home/user/sources         # Directory containing source trees

# Wildcards work with builds and sources too
builds=/home/user/builds,/home/user/other-builds/*

# Per-directory configuration sections
[/home/user/dev/myproject]
prompt=myproj                      # Custom prompt name
default=true                       # Prefer this as default

[/home/user/builds/myproject-debug]
source=/home/user/dev/myproject    # Link build to source
```

### .lsdev_shadows

Place this file in a source directory to define associated build directories.

```ini
# Named build directories
debug=/home/user/builds/myproject-debug
release=/home/user/builds/myproject-release

# Wildcard patterns
builds-*=/home/user/builds/myproject-*

# Scan directories for builds
builds=/home/user/builds

# Scan directories for related sources
sources=/home/user/related-projects
```

### .lsdev_config

Place this file in any directory to configure its behavior.

```ini
name=myproject          # Project name
prompt=myproj           # Short name for shell prompt
source=/path/to/source  # Source directory (for build dirs)
default=true            # Prefer as default selection
ignore=true             # Exclude from listings
```

### .lsdev_default

Stores the last selected directory for the `-` shortcut. Automatically managed by `lsdev -w`.

## Examples

### Basic Navigation

```bash
# List all known directories
lsdev -l

# Jump to a project (with shell function)
cdd myproject

# Jump to project root from any subdirectory
cdd -r

# Jump to last visited directory
cdd -

# Jump to source directory of current build
cdd src

# Jump to build directory of current source
cdd build
```

### Fuzzy Matching

```bash
# Match by partial name
cdd proj              # Matches "myproject", "project2", etc.

# Match multiple terms (all must match)
cdd my debug          # Matches "myproject-debug"

# Exclude matches
cdd proj -test        # Projects matching "proj" but not "test"

# Ido-style matching
lsdev -mi mprj        # Matches "myproject" (m...p...r...j)
```

### Listing and Inspection

```bash
# List all directories with full details
lsdev -l -ta

# Show current project name
lsdev -p

# Show current project name (simple form)
lsdev -p -ts

# Verbose mode to debug configuration
lsdev -v -l
```

### With Wildcards in Config

```ini
# ~/.dev_directories

# Add all directories under ~/dev
projects=/home/user/dev/*

# Add all version directories
versions=/home/user/releases/v*

# Multiple build roots with wildcards
builds=/home/user/builds,/home/user/ci-builds/*
```

## How It Works

1. **Directory Detection**: When you run `lsdev`, it first tries to determine your current project by looking for markers like `.git`, `CMakeLists.txt`, `CMakeCache.txt`, `.lsdev_config`, etc.

2. **Configuration Loading**: It loads `~/.dev_directories` and any `.lsdev_shadows` files to build a list of known directories.

3. **Build/Source Linking**: Build directories are automatically linked to their sources by parsing `CMakeCache.txt` or `config.status`, or via explicit configuration.

4. **Filtering**: Your search terms filter the directory list using the selected matching mode.

5. **Selection**: If multiple directories match, an interactive menu is shown. If only one matches, it's selected automatically.

6. **Output**: The selected path is printed to stdout for use by shell functions.

## Building

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode for development
npm run watch

# Lint
npm run lint

# Clean build artifacts
npm run clean
```

## Requirements

- Node.js 18+
- npm or yarn

## License

ISC
