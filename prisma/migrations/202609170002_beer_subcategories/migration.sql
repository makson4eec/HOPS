ALTER TABLE "Product"
  ADD COLUMN "beerColor" TEXT,
  ADD COLUMN "beerFiltration" TEXT,
  ADD CONSTRAINT "Product_beer_color" CHECK ("beerColor" IN ('light', 'dark')),
  ADD CONSTRAINT "Product_beer_filtration" CHECK ("beerFiltration" IN ('filtered', 'unfiltered'));
