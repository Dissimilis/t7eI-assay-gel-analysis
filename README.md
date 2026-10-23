# T7E1 Gel Analysis

Densitometry for T7 endonuclease I (T7E1) mismatch-cleavage assays. Load a photo of the gel, mark each row of bands, and the app measures the parent band and both cleavage products in every lane and reports % CRISPR editing. It is a single static page in plain HTML, CSS and JavaScript, so images never leave your computer.

**Open the app: <https://dissimilis.github.io/t7eY-assay-gel-analysis/>**

![T7E1 Gel Analysis with the built-in sample gel](docs/screenshot.png)

## Quick start

1. Open the app and press **Load image**, or drop a PNG, JPEG or TIFF onto the image area. Pasting from the clipboard works too.
2. Drag a box over one row of bands. Include the parent band and both cleavage products, and leave the wells out. The app finds the loaded lanes, recognises the ladder and skips empty wells. Repeat for every row of the gel.
3. Check the results table. Set the control lanes to **NC**, exclude lanes you don't need and give lanes your own labels.
4. Export the numbers as **CSV**, or an annotated **Figure PNG** with % editing under every lane.

**Sample gel** loads a synthetic gel with known values, so you can try every control without your own data.

![Exported figure for the sample gel](docs/figure-example.png)

## How lanes are measured

The formula is the one from Guschin et al. (2010), also printed in the NEB T7E1 protocol:

```
fraction cleaved  f = (b + c) / (a + b + c)
% editing         = 100 × (1 − √(1 − f))
```

Here *a* is the uncut parent band and *b* and *c* are the two cleavage products. The square root comes from random reannealing of the PCR product. If a share *p* of the alleles carries an indel and the indels differ from each other, only wild-type strands pair perfectly, so the uncut share is (1 − p)² and p = 1 − √(1 − f).

The pipeline for each row:

- **Lanes.** The lane pitch comes from the autocorrelation of the row's column profile. Lane centres are the half-maximum midpoints of the peaks above a rolling-ball background. Empty wells produce no peak and are skipped.
- **Profiles.** Each lane is a vertical strip, half the lane pitch wide by default. Its mean signal per pixel row is smoothed with a Gaussian (σ 1.5 px).
- **Bands.** The parent band is the strongest peak. The cleavage products are located at offsets shared by the lanes of the row, measured from each lane's own parent band. Tilted rows and slight smiling therefore work, and a faint product is still found where its brighter neighbours put it.
- **Background.** By default a straight line joins the valleys on either side of each band (*Valley*), which is how ImageJ Gel Analyzer is used by hand. *Envelope* draws one line under the whole lane. *Blend* starts from the valley line and moves it towards the envelope where smear lifts the valleys between bands.
- **Areas.** Each band's area is the profile summed above the baseline between its two boundaries. You can drag the boundary markers on the profile plot; the lane is then marked *edited*.
- **Ladders.** A lane with strong bands that match neither the parent nor the product positions is marked as a marker and left out.

### Parameters

| Setting | Default | Options |
|---|---|---|
| Bands | detected from the image | dark on light, light on dark |
| Background | Valley | Valley, Blend, Envelope |
| Cleavage products | Two | Two, One (when one fragment runs off the gel or co-migrates) |
| Formula | Diverse indels (Guschin) | Single allele: f = 2p(1 − p), so % = 100 × (1 − √(1 − 2f)) / 2, valid for f ≤ 0.5 |
| Lane width | 50% of pitch | 20–90% |
| Smoothing | σ 1.5 px | 0–4 px |
| Subtract NC background | off | subtracts the mean fraction cleaved of the NC lanes before the formula |

Settings are remembered in the browser. **Reset defaults** restores them.

### Quality flags

| Flag | Meaning |
|---|---|
| saturated | More than 2% of the parent band core is clipped. The parent area is too small, so % editing reads high and is an upper bound. Take a shorter exposure or use the raw TIFF. |
| P1 / P2 missing | No peak was found at the product position. The area counts as zero. Expected in uncut controls. |
| P1 / P2 faint | The product peak is less than three times the profile noise. The value depends strongly on the baseline. |
| weak | The parent band is barely above background. |
| edge | The parent band touches the box edge. Draw the box a little larger. |
| edited | Band boundaries were moved by hand. |

## Validation

The test suite runs the engine on the synthetic gel: two ladders and 24 lanes whose true editing follows from the reannealing model. Two of those lanes are uncut controls, one is overloaded until the parent band clips and one is underloaded. Lanes and ladders are found automatically. The 20 regular lanes come out with a mean absolute error below 0.8 points and none is off by more than 2 points. The overloaded lane is flagged as saturated and the controls read below 1%.

The engine was also compared with careful hand analysis in ImageJ of a real Invitrogen E-Gel 48 photo with 21 sample lanes. With the default *Valley* background the mean absolute difference was 0.4 points on one row and 1.8 points on the other, and the rank order of lanes was the same. The row with the larger difference has more smear between bands, and the hand analysis counted more of it as band. *Blend* brings the two rows to 0.8 and 0.6 points. The gel itself is not part of this repository; `tests/analysis.test.js` runs that comparison when a local copy is supplied through `T7E1_GEL_PGM`.

## Limitations of the assay

- T7E1 underestimates editing compared with sequencing, and it misses most single-base changes ([Vouillot et al. 2015](https://doi.org/10.1534/g3.114.015834); [Sentmanat et al. 2018](https://doi.org/10.1038/s41598-018-19441-8)).
- The default formula assumes many different indels. A population dominated by one indel gives fewer heteroduplexes: with 50% wild type and 50% of a single mutant allele, f is 0.5 and the default formula reports 29%. Use the *Single allele* formula for clones and near-clonal pools.
- The number is the edited share of PCR product, not of cells.
- Imager JPEGs are 8-bit and often contrast-stretched, so band intensity is not strictly proportional to DNA mass. A raw 16-bit TIFF is better. The app reads uncompressed, LZW, PackBits and Deflate TIFFs.

## Run locally

No build step and no dependencies. Clone the repository and open `index.html`, or serve the folder:

```
python -m http.server 8000
```

Tests need Node.js 22 or newer (`npm test` runs the same command):

```
node --test "tests/*.test.js"
```

## Files

| Path | Contents |
|---|---|
| `index.html` | The page |
| `js/analysis.js` | Densitometry engine (no DOM; also used by the tests) |
| `js/app.js` | User interface |
| `js/tiff.js` | TIFF reader |
| `js/sample.js` | Synthetic sample gel with known values |
| `css/` | Industry design system and app styles |
| `fonts/` | Barlow and Barlow Condensed (SIL Open Font License) |
| `tests/` | Node test suite and TIFF fixtures |

## References

- Guschin DY, Waite AJ, Katibah GE, Miller JC, Holmes MC, Rebar EJ. A rapid and general assay for monitoring endogenous gene modification. *Methods Mol Biol* 2010;649:247–256. [doi:10.1007/978-1-60761-753-2_15](https://doi.org/10.1007/978-1-60761-753-2_15)
- New England Biolabs. [Determining genome targeting efficiency using T7 Endonuclease I](https://international.neb.com/protocols/2014/08/11/determining-genome-targeting-efficiency-using-t7-endonuclease-i).
- Vouillot L, Thélie A, Pollet N. Comparison of T7E1 and Surveyor mismatch cleavage assays to detect mutations triggered by engineered nucleases. *G3* 2015;5:407–415. [doi:10.1534/g3.114.015834](https://doi.org/10.1534/g3.114.015834)
- Sentmanat MF, Peters ST, Florian CP, Connelly JP, Pruett-Miller SM. A survey of validation strategies for CRISPR-Cas9 editing. *Sci Rep* 2018;8:888. [doi:10.1038/s41598-018-19441-8](https://doi.org/10.1038/s41598-018-19441-8)

## License

MIT, see [LICENSE](LICENSE). The Barlow fonts are under the SIL Open Font License 1.1, see [fonts/OFL.txt](fonts/OFL.txt).
