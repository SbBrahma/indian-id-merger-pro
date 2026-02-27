# Indian ID Merger Pro 🇮🇳

A professional, secure, and private web utility to merge front and back images of Indian ID cards (Aadhaar, PAN, Voter ID, etc.) into a single side-by-side or top-bottom document.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=flat&logo=tailwind-css&logoColor=white)

## ✨ Features

- **Standard CR80 Normalization**: Automatically scales images to the standard ID-1 size (85.6 x 53.98 mm).
- **Perspective Correction**: Straighten tilted or skewed photos by selecting the four corners.
- **Live Camera Scan**: Capture ID cards directly using your device's camera with a guided overlay.
- **Dual Layouts**: Merge images side-by-side (Landscape) or top-and-bottom (Vertical).
- **Portrait ID Support**: Specialized handling for vertical ID cards.
- **100% Private**: All processing happens locally in your browser. No images are ever uploaded to a server.

## 🚀 Quick Start

1. **Select Card Shape**: Choose between Landscape or Portrait card types.
2. **Add Images**: Use the **Scan** button to take a photo or **Upload** to select a file.
3. **Edit & Straighten**: Use the Perspective tool to align the corners of your ID.
4. **Merge**: Click "Merge & Standardize" to generate your document.
5. **Download**: Save the final high-quality JPG.

## 🛠️ Tech Stack

- **Framework**: React 18 with Vite
- **Styling**: Tailwind CSS
- **Animations**: Framer Motion
- **Image Processing**: HTML5 Canvas API & `react-easy-crop`
- **Icons**: Lucide React

## 📦 Deployment

This project is configured for automatic deployment to **GitHub Pages** via GitHub Actions.

1. Create a new repository on GitHub.
2. Push your code to the `main` branch.
3. Go to **Settings > Pages** and set the Source to **GitHub Actions**.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
