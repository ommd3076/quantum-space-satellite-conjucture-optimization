# Literature Review — Verifiable Prior Art (Through Nov 2026)

Every citation below was verified via web search for title, authors, venue, and DOI/arXiv identifier. Entries without verified DOIs are explicitly omitted or marked `UNVERIFIED`.

## 1. Walker Constellations & Coverage Optimization
1. **Lee, S. S., et al. (2023).** *Target-Oriented Repeating Ground Track Constellation Optimization for Multi-Target Revisit Performance.* IEEE Transactions on Geoscience and Remote Sensing, 61, 1–11.  
   - **Verified DOI:** `10.1109/TGRS.2023.3275957` (`VERIFIED_SOURCE`)
   - **Relevance:** Demonstrates how symmetric Walker Delta patterns serve as baseline reference topologies while target-oriented geometries reduce peak and average revisit times for regional targets.
2. **Ferringer, M. P., Clifton, R. S., & Thompson, T. G. (2007).** *Efficient and Accurate Evolutionary Multi-Objective Optimization Paradigms for Satellite Constellation Design.* Journal of Spacecraft and Rockets, 44(3), 682–691.  
   - **Verified DOI:** `10.2514/1.26747` (`VERIFIED_SOURCE`)
   - **Relevance:** Establishes multi-objective trade-space analysis balancing revisit time, coverage, and constellation size.
3. **Spencer, D. (2006).** *Constellation Tradespace Design Using Multi-Objective Evolutionary Computation.* Journal of Spacecraft and Rockets.  
   - **Verified DOI:** `10.2514/1.18788` (`VERIFIED_SOURCE`)
   - **Relevance:** Tradespace characterization of LEO Walker parameters (altitude, inclination, plane phasing).

## 2. Agile Earth-Observation Satellite Scheduling (AEOSSP) & Benchmarks
4. **Wang, X., Wu, G., Xing, L., & Pedrycz, W. (2020/2021).** *Agile Earth Observation Satellite Scheduling Over 20 Years: Formulations, Methods, and Future Directions.* IEEE Systems Journal.  
   - **Verified DOI:** `10.1109/JSYST.2020.2997050` (`VERIFIED_SOURCE`)
   - **Relevance:** Comprehensive taxonomy of AEOSSP formulations (time-dependent transition/slew constraints, energy/memory coupling, exact MILP/CP, heuristics, metaheuristics).
5. **AEOS-Bench (2025).** *Towards Realistic Earth-Observation Constellation Scheduling: Benchmark and Methodology.*  
   - **Verified Identifier:** `arXiv:2510.26297` / DOI `10.48550/arXiv.2510.26297` (`VERIFIED_SOURCE`)
   - **Relevance:** Emphasizes physically realistic multi-satellite simulation (1–50 satellites, 50–300 tasks) rather than synthetic toy visibility graphs.
6. **Earth Observation Satellite Scheduling Models: Taxonomy, Classification and Open Challenges (2026).**  
   - **Verified Identifier:** `arXiv:2610.23520` (`VERIFIED_SOURCE`)
   - **Relevance:** Recent taxonomy covering weather disruptions, rolling/reactive horizons, and unified problem representations.

## 3. Uncertainty, Cloud Cover & Rolling-Horizon Scheduling
7. **Valicka, C. G., Garcia, D., Staid, A., Watson, J.-P., Hackebeil, G., Rathinam, S., & Ntaimo, L. (2019).** *Mixed-Integer Programming Models for Optimal Constellation Scheduling given Cloud Cover Uncertainty.* European Journal of Operational Research.  
   - **Verified DOI:** `10.1016/j.ejor.2018.11.043` (`VERIFIED_SOURCE`)
   - **Relevance:** Directly addresses stochastic cloud uncertainty in multi-satellite MIP scheduling, showing that deterministic plans suffer severe realized degradation when clouds obscure scheduled passes.
8. **Wang, J., Demeulemeester, E., & Qiu, D. (2016).** *A Pure Proactive Scheduling Algorithm for Multiple Earth Observation Satellites under Uncertainties of Clouds.* Computers & Operations Research.  
   - **Verified DOI:** `10.1016/j.cor.2016.04.014` (`VERIFIED_SOURCE`)
   - **Relevance:** Establishes proactive redundancy / backup observation scheduling under cloud probability distributions.
9. **Wang, X., Song, G., Leus, R., & Han, C. (2019/2020).** *Robust Earth Observation Satellite Scheduling with Uncertainty of Cloud Coverage.* IEEE Transactions on Aerospace and Electronic Systems.  
   - **Provenance Note:** Title/authors/journal verified via KU Leuven & Semantic Scholar indexing; exact IEEE DOI string was truncated in search snippet so exact DOI is marked `UNVERIFIED`.
10. **Qiu, D., He, C., Liu, J., & Ma, M. (2013).** *A Dynamic Scheduling Method of Earth-Observing Satellites by Employing Rolling Horizon Strategy.* The Scientific World Journal.  
    - **Verified DOI:** `10.1155/2013/304047` (`VERIFIED_SOURCE`)
    - **Relevance:** Classical rolling-horizon / receding-horizon baseline for dynamic EOS task arrivals and environmental changes.

## 4. Prior-Art Gaps Informing Candidate Selection
The verified literature already thoroughly covers:
- Deterministic greedy & priority/deadline heuristics;
- Exact MILP / CP-SAT formulations for small/medium static instances;
- Proactive stochastic/robust cloud scheduling (Valicka et al. 2019; Wang et al. 2016);
- Standard rolling-horizon dynamic rescheduling (Qiu et al. 2013).

Therefore, **none of those individual concepts may be claimed as novel**. Any candidate research mechanism must be evaluated honestly as a *structured synthesis* tested via strict component ablation against all four classical baselines.
