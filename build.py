import os
import json
import subprocess
import sys
import importlib.util

def install_missing_deps(deps):
    """Checks if deps are installed, and installs them if they are missing."""
    if not deps:
        return

    missing = []
    for dep in deps:
        # Check if the package is already available in the environment
        # We use find_spec to check without actually importing (cleaner)
        if importlib.util.find_spec(dep.split('==')[0].split('>')[0]) is None:
            missing.append(dep)

    if missing:
        print(f"Installing missing plugin dependencies: {missing}...")
        try:
            # -m pip install ensures we use the same python as the builder
            subprocess.check_call([sys.executable, "-m", "pip", "install"] + missing)
            print("Successfully installed dependencies.")
        except subprocess.CalledProcessError as e:
            print(f"Failed to install dependencies. Build may fail. Error: {e}")
    else:
        print("All plugin dependencies are already installed in the environment.")

def get_plugin_dependencies(plugins_folder="plugins"):
    dependencies = set()
    if not os.path.exists(plugins_folder):
        return []

    for item in os.listdir(plugins_folder):
        item_path = os.path.join(plugins_folder, item)
        manifest_path = os.path.join(item_path, "manifest.json")
        if os.path.isdir(item_path) and os.path.exists(manifest_path):
            try:
                with open(manifest_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for dep in data.get("dependencies", []):
                        dependencies.add(dep)
            except Exception as e:
                print(f"Error reading manifest in {item}: {e}")
    return list(dependencies)

def run_build():
    # 1. Collect dependencies
    plugin_deps = get_plugin_dependencies()
    
    # 2. INSTALL them to the current environment so Nuitka can find them
    install_missing_deps(plugin_deps)

    # 3. Base Nuitka command
    build_command = [
        sys.executable, "-m", "nuitka",
        "--standalone",
        "--onefile",
        "--include-package-data=webview",
        "--include-module=webview.platforms.winforms",
        "--include-module=clr",
        "--assume-yes-for-downloads",
        "--zig",
        "--output-filename=yt_music",
    ]

    # 4. Tell Nuitka to include these packages
    for dep in plugin_deps:
        # Extract base name (e.g., 'requests==2.0' -> 'requests')
        clean_name = dep.split('==')[0].split('>')[0].split('<')[0]
        build_command.append(f"--include-package={clean_name}")

    build_command.append("src/main.py")

    print("\nRunning Nuitka Build...")
    try:
        subprocess.run(build_command, check=True)
        print("\nBuild Successful!")
    except subprocess.CalledProcessError as e:
        print(f"\nBuild failed with exit code {e.returncode}")

if __name__ == "__main__":
    run_build()